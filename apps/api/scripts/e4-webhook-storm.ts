/**
 * Experiment E4c: a storm of duplicate webhooks for one payment, against the running stack.
 *
 *   node scripts/e4-webhook-storm.ts            (from apps/api; reads ../../.env, prints no secrets)
 *
 * Places a real order (Razorpay test mode creates a real provider order), then sends
 * `payment.captured` for it, signed with our webhook secret, through NGINX:
 *   1. N copies of ONE event at the same instant (Razorpay redelivering the same event)
 *   2. N different events about the SAME payment at once (e.g. payment.captured + order.paid)
 * Expectation: exactly one delivery pays the order; every other one answers 200 "duplicate".
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:8088';
const N = Number(process.env.N ?? 50);
const secret = (process.env.RAZORPAY_WEBHOOK_SECRET ?? '').trim();
if (!secret) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set in .env');

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const login = await call('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'loadtest+2@scalecart.local', password: (process.env.SEED_USER_PASSWORD ?? '').trim() }),
});
if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
const token: string = login.body.accessToken;

await call('/cart', { method: 'DELETE', token });
const found = (await call('/products/search?q=running%20shoes&limit=1')).body;
const product = (found.items ?? found)[0];
await call(`/cart/items/${product.id}`, {
  method: 'PUT',
  token,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ quantity: 1 }),
});
const order = (await call('/checkout', {
  method: 'POST',
  token,
  headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
  body: '{}',
})).body;
const session = (await call(`/orders/${order.id}/payment`, { method: 'POST', token })).body;
console.log(`order ${order.id} (₹${order.totalCents / 100}), provider order ${session.providerOrderId}`);

const paymentId = `pay_storm${randomBytes(5).toString('hex')}`;
const body = (event: string) =>
  JSON.stringify({
    entity: 'event',
    event,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: session.providerOrderId,
          amount: session.amountPaise,
          currency: 'INR',
          status: 'captured',
          method: 'card',
          captured: true,
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

async function deliver(raw: string, eventId: string) {
  const started = performance.now();
  const res = await call('/payments/razorpay/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
    body: raw,
  });
  return { ms: performance.now() - started, status: res.status, outcome: `${res.body?.status ?? "?"}/${res.body?.outcome ?? res.body?.message}` };
}

function report(name: string, results: Awaited<ReturnType<typeof deliver>>[]) {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))].toFixed(1);
  const tally: Record<string, number> = {};
  for (const r of results) tally[`${r.status} ${r.outcome}`] = (tally[`${r.status} ${r.outcome}`] ?? 0) + 1;
  console.log(`${name}: ${JSON.stringify(tally)} | ms min ${ms[0].toFixed(1)} p50 ${pct(50)} p95 ${pct(95)} max ${ms.at(-1)!.toFixed(1)}`);
}

const sameEvent = body('payment.captured');
const eventId = `evt_storm_${randomBytes(4).toString('hex')}`;
report(`1) ${N} copies of one event`, await Promise.all(Array.from({ length: N }, () => deliver(sameEvent, eventId))));

const different = await Promise.all(
  Array.from({ length: N }, (_, i) => deliver(body(i % 2 ? 'order.paid' : 'payment.captured'), `evt_storm_${randomBytes(6).toString('hex')}`)),
);
report(`2) ${N} different events, same payment`, different);

const final = (await call(`/orders/${order.id}`, { token })).body;
console.log(`order status: ${final.status}`);
