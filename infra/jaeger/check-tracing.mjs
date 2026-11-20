// Checks distributed tracing against the running Compose stack, and measures it:
//   node infra/jaeger/check-tracing.mjs          one payment (a quick check)
//   N=20 node infra/jaeger/check-tracing.mjs     20 payments (E13c)
//
// For each payment: checkout → Pay (real Razorpay test order) → a self-signed payment.captured webhook. Then it reads
// both traces back from Jaeger (by the X-Trace-Id Kong returned) and checks that:
//   Pay:     kong → payments → shop (order lookup)                                        is one trace
//   webhook: kong → payments → RabbitMQ → shop-worker (order paid) → RabbitMQ → payments  is one trace
// It also reports how long the event waited in the payments outbox (webhook done → relay publishes it).
// Secrets come from the repo-root .env and are never printed. Exits 1 if any check fails.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '../..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = 'http://localhost:8088';
const JAEGER = 'http://localhost:16686';
const N = Number(process.env.N ?? 1);

async function call(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, traceId: res.headers.get('x-trace-id') };
}

async function login(n) {
  const r = await call('POST', '/auth/login', { email: `loadtest+${n}@scalecart.local`, password: env.SEED_USER_PASSWORD });
  return r.json.accessToken; // undefined for seed users with 2FA on
}

async function order(token) {
  for (let i = 0; i < 5; i++) {
    await call('DELETE', '/cart', undefined, token);
    await call('PUT', `/cart/items/${1000 + Math.floor(Math.random() * 150_000)}`, { quantity: 1 }, token);
    const o = await call('POST', '/checkout', {}, token, { 'idempotency-key': randomUUID() });
    if (o.status === 201) return o.json.id;
  }
  throw new Error('could not create an order');
}

function webhookFor(pay) {
  const body = JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: `pay_e13${randomUUID().replaceAll('-', '').slice(0, 14)}`,
          entity: 'payment',
          amount: pay.amountPaise,
          currency: 'INR',
          status: 'captured',
          order_id: pay.providerOrderId,
          method: 'card',
          captured: true,
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
  const sig = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  return call('POST', '/payments/razorpay/webhook', body, undefined, {
    'x-razorpay-signature': sig,
    'x-razorpay-event-id': `evt_${randomUUID()}`,
  });
}

/** The trace from Jaeger, waiting until `ready(spans)` holds (each service sends its spans in batches, every few
 *  seconds, so the last part of a trace can arrive well after the first). Gives up after ~60 s. */
async function traceOf(id, ready) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${JAEGER}/api/traces/${id}`);
    if (r.ok) {
      const t = (await r.json()).data?.[0];
      if (t) {
        const svc = Object.fromEntries(Object.entries(t.processes).map(([k, v]) => [k, v.serviceName]));
        const spans = t.spans.map((s) => ({ ...s, service: svc[s.processID] }));
        if (ready(spans)) return spans;
      }
    }
    await sleep(500);
  }
  return null;
}

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    failed++;
    console.log(`FAIL  ${name} ${detail}`);
  }
  return ok;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const tokens = [];
for (let n = 30; tokens.length < Math.ceil(N / 5); n++) {
  const t = await login(n);
  if (t) tokens.push(t);
}

const payComplete = [];
const hookComplete = [];
const outboxWait = [];
const endToEnd = [];
/** Seconds from "Pay answered" until the whole Pay trace could be read in Jaeger (spans are sent in batches). */
const completeAfter = [];
/** Per Pay: total ms at Kong, ms spent waiting for Razorpay's API, ms for the shop lookup. */
const payBreakdown = [];
for (let i = 0; i < N; i++) {
  const token = tokens[Math.floor(i / 5)];
  const orderId = await order(token);
  const pay = await call('POST', `/orders/${orderId}/payment`, undefined, token);
  if (!check('Pay works', pay.status === 201, `${pay.status} ${JSON.stringify(pay.json)}`)) continue;
  const hook = await webhookFor(pay.json);
  check('webhook accepted', hook.status === 200, `${hook.status}`);

  // Wait for EVERY expected service: each one sends its spans in its own batches (Kong's too), in any order.
  const has = (spans, services) => services.every((s) => spans.some((x) => x.service === s));
  const sentAt = Date.now();
  const paySpans = await traceOf(pay.traceId, (s) => has(s, ['kong', 'payments', 'shop-api']));
  const payOk = check('Pay trace: kong → payments → shop', !!paySpans, pay.traceId);
  if (payOk) {
    completeAfter.push((Date.now() - sentAt) / 1000);
    // Where Pay's time goes: the whole request at Kong vs the call to Razorpay's API vs the lookup at the shop.
    const total = paySpans.find((x) => x.service === 'kong' && x.operationName === 'kong');
    const urlOf = (x) => String(x.tags?.find((t) => t.key === 'url.full' || t.key === 'http.url')?.value ?? '');
    const razorpay = paySpans.find((x) => x.service === 'payments' && urlOf(x).includes('razorpay'));
    const shop = paySpans.find((x) => x.service === 'payments' && urlOf(x).includes('/internal/orders/'));
    if (total && razorpay) payBreakdown.push({ total: total.duration / 1000, razorpay: razorpay.duration / 1000, shop: (shop?.duration ?? 0) / 1000 });
  }
  payComplete.push(payOk);

  const isReplyDone = (x) => x.service === 'payments' && x.operationName.includes('order-results') && x.operationName.includes('process');
  const hookSpans = await traceOf(hook.traceId, (s) => has(s, ['kong', 'payments', 'shop-worker']) && s.some(isReplyDone));
  const hookOk = check('webhook trace: kong → payments → shop-worker → payments', !!hookSpans, hook.traceId);
  hookComplete.push(hookOk);
  if (hookOk) {
    const webhook = hookSpans.find((x) => x.service === 'payments' && x.operationName.includes('/payments/razorpay/webhook'));
    const publish = hookSpans.find((x) => x.service === 'payments' && x.operationName.startsWith('publish'));
    const reply = hookSpans.find(isReplyDone);
    if (webhook && publish) outboxWait.push((publish.startTime - (webhook.startTime + webhook.duration)) / 1000);
    const kong = hookSpans.find((x) => x.service === 'kong' && x.operationName === 'kong');
    if (kong && reply) endToEnd.push((reply.startTime + reply.duration - kong.startTime) / 1000);
  }
  if (N === 1) {
    console.log(`Pay trace ${pay.traceId}: ${paySpans?.length ?? 0} spans`);
    console.log(`webhook trace ${hook.traceId}: ${hookSpans?.length ?? 0} spans`);
  }
}

console.log(`Pay traces complete:     ${payComplete.filter(Boolean).length} of ${payComplete.length}`);
if (completeAfter.length) console.log(`a Pay trace was complete in Jaeger after s: p50 ${pct(completeAfter, 50).toFixed(1)}, max ${Math.max(...completeAfter).toFixed(1)}`);
if (payBreakdown.length) {
  const share = payBreakdown.map((b) => (100 * b.razorpay) / b.total);
  console.log(
    `Pay ms p50 / max: total ${pct(payBreakdown.map((b) => b.total), 50).toFixed(0)} / ${Math.max(...payBreakdown.map((b) => b.total)).toFixed(0)}, ` +
      `Razorpay API ${pct(payBreakdown.map((b) => b.razorpay), 50).toFixed(0)} / ${Math.max(...payBreakdown.map((b) => b.razorpay)).toFixed(0)}, ` +
      `shop lookup ${pct(payBreakdown.map((b) => b.shop), 50).toFixed(1)} / ${Math.max(...payBreakdown.map((b) => b.shop)).toFixed(1)}; ` +
      `Razorpay's share of Pay: p50 ${pct(share, 50).toFixed(0)}% (min ${Math.min(...share).toFixed(0)}%)`,
  );
}
console.log(`webhook traces complete: ${hookComplete.filter(Boolean).length} of ${hookComplete.length}`);
if (outboxWait.length) {
  console.log(`outbox wait (webhook done → event published) ms: p50 ${pct(outboxWait, 50).toFixed(1)}, max ${Math.max(...outboxWait).toFixed(1)}`);
  console.log(`webhook arrives → reply handled by payments ms: p50 ${pct(endToEnd, 50).toFixed(1)}, max ${Math.max(...endToEnd).toFixed(1)}`);
}

// Background work must not create traces of its own (the sampler drops them): every recent trace that touches the
// shop-worker must have started at a request (SERVER span) or a message (CONSUMER span), never at a bare query from
// the outbox relay or a job. Jaeger 2's search API is /api/v3 (OpenTelemetry JSON; span kind 2 = SERVER, 5 = CONSUMER).
const iso = (ms) => new Date(ms).toISOString();
const search = await fetch(
  `${JAEGER}/api/v3/traces?query.service_name=shop-worker&query.start_time_min=${iso(Date.now() - 10 * 60_000)}&query.start_time_max=${iso(Date.now())}&query.search_depth=200`,
);
const spans = ((await search.json()).result?.resourceSpans ?? []).flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
const byTrace = Map.groupBy(spans, (s) => s.traceId);
const bare = [...byTrace.values()].filter((trace) => {
  const ids = new Set(trace.map((s) => s.spanId));
  const roots = trace.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
  return roots.some((s) => s.kind !== 2 && s.kind !== 5 && !s.parentSpanId);
});
check(`no traces from background work (${byTrace.size} recent shop-worker traces looked at)`, bare.length === 0, `${bare.length} found`);
console.log(`recent shop-worker traces: ${byTrace.size}, started by background work: ${bare.length}`);


console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
