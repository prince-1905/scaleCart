/**
 * E11: what the payments split costs and what it buys, measured against the running Compose stack.
 *
 *   node scripts/e11-payments-split.ts <part>      (from apps/api; parts: hop | settle | shopdown | paydown | breaker)
 *
 * It stops/starts/pauses containers (docker compose) and talks to the stack through NGINX (http://localhost:8088).
 * Order states are read straight from MySQL (host port 3307) so the numbers don't depend on NGINX or the shop.
 * Webhooks are self-signed with RAZORPAY_WEBHOOK_SECRET; "Pay" creates real Razorpay test-mode orders.
 * Secrets come from the repo-root .env and are never printed.
 */
import { execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mysql from 'mysql2/promise';

const ROOT = resolve(import.meta.dirname, '../../..');
const env: Record<string, string> = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = 'http://localhost:8088';
const API_CONTAINER = process.env.API_CONTAINER ?? 'scalecart-api-4';
const PAYMENTS_CONTAINER = 'scalecart-payments-1';

const db = mysql.createPool({ host: '127.0.0.1', port: 3307, user: 'root', password: env.MYSQL_ROOT_PASSWORD, connectionLimit: 2 });

interface Res {
  status: number;
  json: any;
  ms: number;
}
async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Res> {
  const t = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text.slice(0, 80);
    }
    return { status: res.status, json, ms: performance.now() - t };
  } catch (err) {
    return { status: 0, json: (err as Error).message, ms: performance.now() - t };
  }
}

const compose = (args: string) => execSync(`docker compose ${args}`, { cwd: ROOT, stdio: 'pipe' });
const docker = (args: string) => execSync(`docker ${args}`, { cwd: ROOT, stdio: 'pipe' }).toString();
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(stamp(), ...a);
const r = (n: number) => Math.round(n * 10) / 10;
function pct(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return { n: s.length, p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(s[s.length - 1]) };
}
const countBy = (xs: (string | number)[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

/** A seed user picked at random (fresh rate-limit buckets per run). */
async function login(): Promise<string> {
  const n = 100 + Math.floor(Math.random() * 1800);
  const res = await call('POST', '/auth/login', { email: `loadtest+${n}@scalecart.local`, password: env.SEED_USER_PASSWORD });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.accessToken;
}

/** One normal catalog item (random seed product; skips sold-out ones and drop items). */
async function makeOrder(token: string): Promise<{ id: string; totalCents: number }> {
  for (let attempt = 1; ; attempt++) {
    await call('DELETE', '/cart', undefined, token);
    const productId = 1000 + Math.floor(Math.random() * 150_000);
    const put = await call('PUT', `/cart/items/${productId}`, { quantity: 1 }, token);
    const order = put.status < 300 ? await call('POST', '/checkout', {}, token, { 'idempotency-key': randomUUID() }) : put;
    if (order.status < 300) return order.json;
    if (attempt === 5 || ![403, 404, 409].includes(order.status)) {
      throw new Error(`order ${order.status} ${JSON.stringify(order.json)}`);
    }
  }
}

/** n orders spread over several users (checkout allows a burst of 5 per user). */
async function makeOrders(n: number) {
  const out: { id: string; token: string }[] = [];
  let token = '';
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) token = await login();
    out.push({ id: (await makeOrder(token)).id, token });
  }
  return out;
}

async function pay(orderId: string, token: string) {
  return call('POST', `/orders/${orderId}/payment`, undefined, token);
}

async function webhook(p: { providerOrderId: string; amountPaise: number }) {
  const body = JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: `pay_e11${randomUUID().replaceAll('-', '').slice(0, 14)}`,
          entity: 'payment',
          amount: p.amountPaise,
          currency: 'INR',
          status: 'captured',
          order_id: p.providerOrderId,
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

async function statuses(ids: string[]): Promise<Map<string, string>> {
  const [rows] = await db.query(`SELECT id, status FROM scalecart_orders.orders WHERE id IN (?)`, [ids]);
  return new Map((rows as { id: string; status: string }[]).map((x) => [x.id, x.status]));
}

/** Polls MySQL until every order has `status`; returns ms (from `since`) at which each one got there. */
async function waitFor(ids: string[], status: string, since: number, timeoutMs: number) {
  const at = new Map<string, number>();
  while (at.size < ids.length && performance.now() - since < timeoutMs) {
    for (const [id, s] of await statuses(ids)) if (s === status && !at.has(id)) at.set(id, performance.now() - since);
    if (at.size < ids.length) await sleep(10);
  }
  return at;
}

function queueDepth(name: string): string {
  const out = docker(`exec scalecart-rabbitmq-1 rabbitmqctl list_queues name messages --quiet`);
  return out.split(/\r?\n/).find((l) => l.split(/\s+/)[0] === name) ?? `${name} ?`;
}

// ── parts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The price of one network hop: payments → shop "how much is order X", next to the same lookup done in-process. */
async function hop() {
  const [order] = await makeOrders(1);
  const N = 500;
  const timing = (expr: string) => `
    const t = []; for (let i = 0; i < 50 + ${N}; i++) { const s = performance.now(); ${expr}; if (i >= 50) t.push(performance.now() - s); }
    t.sort((a, b) => a - b); const at = (p) => t[Math.ceil(p / 100 * t.length) - 1];
    console.log(JSON.stringify({ n: t.length, p50: at(50).toFixed(2), p95: at(95).toFixed(2), p99: at(99).toFixed(2), max: t.at(-1).toFixed(2) }));`;
  const inPayments = (label: string, expr: string) => {
    const script = `(async () => { ${timing(expr)} })()`;
    log(label, docker(`exec ${PAYMENTS_CONTAINER} node -e "${script.replaceAll('"', '\\"').replaceAll('\n', ' ')}"`).trim());
  };
  inPayments(
    'HTTP hop only (payments → shop /health/live):',
    `await (await fetch(process.env.SHOP_URL + '/health/live')).text()`,
  );
  inPayments(
    'internal order lookup (payments → shop /internal/orders/:id):',
    `await (await fetch(process.env.SHOP_URL + '/internal/orders/${order.id}', { headers: { 'x-service-token': process.env.INTERNAL_SERVICE_TOKEN } })).json()`,
  );
  // Before the split, startPayment did this query in-process. Same query, run inside the shop container.
  const sql = `SELECT id, user_id AS userId, status, total_cents AS totalCents, payment_id AS paymentId, created_at AS createdAt FROM orders WHERE id = ?`;
  const inShop = `import('mysql2/promise').then(async ({ default: m }) => {
    const c = await m.createConnection({ host: process.env.DB_HOST, port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: 'scalecart_orders' });
    ${timing(`await c.query('${sql}', ['${order.id}'])`)} await c.end(); })`;
  log(
    'same lookup in-process (shop → MySQL, the monolith way):',
    docker(`exec -w /app ${API_CONTAINER} node -e "${inShop.replaceAll('"', '\\"').replaceAll('\n', ' ')}"`).trim(),
  );
}

/** Pay end to end, and webhook → order paid through the queue (before the split this was one HTTP request). */
async function settle() {
  const N = 20;
  const orders = await makeOrders(N);
  const pays: Res[] = [];
  for (const o of orders) pays.push(await pay(o.id, o.token));
  log('Pay statuses', countBy(pays.map((p) => p.status)), 'Pay ms', pct(pays.map((p) => p.ms)));
  const hookMs: number[] = [];
  const settleMs: number[] = [];
  for (let i = 0; i < N; i++) {
    if (pays[i].status !== 201) continue;
    const t0 = performance.now();
    const h = await webhook(pays[i].json);
    hookMs.push(h.ms);
    const at = await waitFor([orders[i].id], 'paid', t0, 10_000);
    settleMs.push(at.get(orders[i].id) ?? NaN);
    await sleep(300);
  }
  log('webhook response ms', pct(hookMs));
  log('webhook sent → order paid in MySQL ms', pct(settleMs.filter(Number.isFinite)), 'not settled:', settleMs.filter((x) => !Number.isFinite(x)).length);
}

/** Shop (API + worker) down for 60 s: are webhooks still accepted, and do the orders catch up? */
async function shopdown() {
  const N = 20;
  const OUTAGE_MS = 60_000;
  const orders = await makeOrders(N);
  const pays: Res[] = [];
  for (const o of orders) pays.push(await pay(o.id, o.token));
  log('Pay statuses before the outage', countBy(pays.map((p) => p.status)));
  const ids = orders.filter((_, i) => pays[i].status === 201).map((o) => o.id);

  log('stopping api + worker');
  const down = performance.now();
  compose('stop api worker');
  log(`stopped in ${r(performance.now() - down)} ms`);
  const hooks: Res[] = [];
  for (let i = 0; i < N; i++) if (pays[i].status === 201) hooks.push(await webhook(pays[i].json));
  log('webhooks during outage', countBy(hooks.map((h) => h.status)), 'ms', pct(hooks.map((h) => h.ms)));
  const browse = await call('GET', '/products/search?limit=5');
  log('browse during outage →', browse.status, `${r(browse.ms)} ms`);
  const payNow = await pay(orders[0].id, orders[0].token);
  log('Pay during outage →', payNow.status, JSON.stringify(payNow.json).slice(0, 80), `${r(payNow.ms)} ms`);
  await sleep(5_000);
  log('order statuses during outage', countBy([...(await statuses(ids)).values()]));
  log('queue', queueDepth('orders.payment-captured'));
  const wait = OUTAGE_MS - (performance.now() - down);
  if (wait > 0) await sleep(wait);

  log('starting api + worker');
  const up = performance.now();
  compose('start api worker');
  log(`start command returned in ${r(performance.now() - up)} ms`);
  const at = await waitFor(ids, 'paid', up, 120_000);
  log(`orders paid after restart: ${at.size}/${ids.length}`, 'ms after start command', pct([...at.values()]));
  log('order statuses now', countBy([...(await statuses(ids)).values()]));
  compose('restart lb'); // NGINX resolved "api" at boot; the restarted container may have a new IP
  log('queue', queueDepth('orders.payment-captured'));
}

/** Payments down: browsing and checkout unaffected? Pay fails fast? Overdue orders are not cancelled blindly. */
async function paydown() {
  const token = await login();
  const ids = (await call('GET', '/products/search?limit=20')).json.map((p: { id: string }) => p.id);
  const browse = async () => {
    const res: Res[] = [];
    for (let i = 0; i < 150; i++) {
      res.push(i % 2 ? await call('GET', '/products/search?q=a&limit=10', undefined, token) : await call('GET', `/products/${ids[i % ids.length]}`, undefined, token));
      await sleep(60); // ~15 req/s, under the per-user limit of 20/s
    }
    return { statuses: countBy(res.map((x) => x.status)), ms: pct(res.map((x) => x.ms)) };
  };
  const checkouts = async () => {
    const t = await login();
    const res: number[] = [];
    const st: (string | number)[] = [];
    for (let i = 0; i < 5; i++) {
      const s = performance.now();
      try {
        await makeOrder(t);
        st.push('ok');
      } catch (err) {
        st.push((err as Error).message.slice(0, 30));
      }
      res.push(performance.now() - s);
    }
    return { statuses: countBy(st), ms: pct(res) };
  };

  log('payments UP   browse', JSON.stringify(await browse()));
  log('payments UP   cart+checkout', JSON.stringify(await checkouts()));
  const overdue = await makeOrders(10);

  log('stopping payments');
  compose('stop payments');
  const down = performance.now();
  log('payments DOWN browse', JSON.stringify(await browse()));
  log('payments DOWN cart+checkout', JSON.stringify(await checkouts()));
  const p = await pay(overdue[0].id, overdue[0].token);
  log('payments DOWN Pay →', p.status, `${r(p.ms)} ms`);

  // Pretend these 10 orders are past their 15-minute deadline. The worker's expiry job runs every 30 s.
  await db.query(`UPDATE scalecart_orders.orders SET created_at = created_at - INTERVAL 1000 SECOND WHERE id IN (?)`, [overdue.map((o) => o.id)]);
  log('10 orders back-dated past the deadline; waiting 45 s (at least one expiry round)');
  await sleep(45_000);
  log('their statuses with payments down', countBy([...(await statuses(overdue.map((o) => o.id))).values()]));

  log('starting payments');
  const up = performance.now();
  compose('start payments');
  const at = await waitFor(overdue.map((o) => o.id), 'cancelled', up, 120_000);
  log(`cancelled after payments came back: ${at.size}/10`, 'ms after start', pct([...at.values()]));
  log(`payments was down for ${r((up - down) / 1000)} s`);
}

/** A hung shop: every lookup times out. How long does Pay take before and after the circuit breaker opens? */
async function breaker() {
  const [order] = await makeOrders(1);
  const token = order.token;
  const burst = async (n: number) => {
    const res = await Promise.all(Array.from({ length: n }, () => pay(order.id, token)));
    return { statuses: countBy(res.map((x) => x.status)), ms: pct(res.map((x) => x.ms)) };
  };
  log(`pausing ${API_CONTAINER} (process frozen: connections open but nothing answers)`);
  docker(`pause ${API_CONTAINER}`);
  try {
    const seq: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await pay(order.id, token);
      seq.push(`${res.status}/${Math.round(res.ms)}ms`);
    }
    log('8 Pay clicks one after another:', seq.join(' '));
    log('30 at once while open:', JSON.stringify(await burst(30)));
    log('waiting 11 s (breaker open time is 10 s)');
    await sleep(11_000);
    const trial: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await pay(order.id, token);
      trial.push(`${res.status}/${Math.round(res.ms)}ms`);
    }
    log('after 10 s, 3 clicks (first one is the trial call):', trial.join(' '));
  } finally {
    docker(`unpause ${API_CONTAINER}`);
    log('unpaused');
  }
  await sleep(11_000);
  const ok = await pay(order.id, token);
  log('shop back, after 11 s: Pay →', ok.status, `${r(ok.ms)} ms`);
}

const parts: Record<string, () => Promise<void>> = { hop, settle, shopdown, paydown, breaker };
const part = process.argv[2];
if (!parts[part]) {
  console.error(`usage: node scripts/e11-payments-split.ts <${Object.keys(parts).join('|')}>`);
  process.exit(2);
}
log(`E11 ${part}`);
try {
  await parts[part]();
} finally {
  await db.end();
}
