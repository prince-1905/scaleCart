/**
 * E5 — A drop with and without the waiting room.
 *
 * BUYERS customers each have the drop product in their cart and act at the same instant,
 * the drop's start (connections opened beforehand, as in e1-flash-sale.js):
 *
 *   MODE=direct  the drop lets everyone in at once (admit 10,000/s): all checkouts hit
 *                the API together, like Phase 2's burst
 *   MODE=room    the waiting room admits ADMIT buyers per second: everyone joins the line
 *                at once (a cheap Redis call), then waits until their ticket is called,
 *                then checks out with the pass
 *   MODE=window  "one out, one in": at most SHOPPERS called buyers at once; the next ticket is
 *                called when one finishes checkout
 *
 * STALL_MS=5000 jams the counter on purpose: STALL_AT seconds (default 5) after the start, the
 * lab endpoint holds the product's stock row locked for STALL_MS, like a commit stuck on a slow
 * disk. Every mode gets the same stall at the same moment (needs LAB_ENDPOINTS=true).
 *
 * Same product setup, same drop code path; only the admit rate differs.
 * STOCK defaults to BUYERS, so every checkout does real work (no cheap "sold out" answers).
 *
 *   ./load-tests/run.ps1 -Script e5-drop.js -K6Env MODE=direct
 *   ./load-tests/run.ps1 -Script e5-drop.js -K6Env MODE=room,ADMIT=50
 *   ./load-tests/run.ps1 -Script e5-drop.js -K6Env MODE=window,SHOPPERS=50,STALL_MS=5000
 */
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL } from './lib/steps.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, auth, available, createProduct, login, loginMany } from './lib/shop.js';

const BUYERS = Number(__ENV.BUYERS || 1000);
const MODE = __ENV.MODE || 'room';
const ADMIT = MODE === 'direct' ? 10_000 : Number(__ENV.ADMIT || 50);
const SHOPPERS = Number(__ENV.SHOPPERS || 50);
const STOCK = Number(__ENV.STOCK || BUYERS);
const STALL_MS = Number(__ENV.STALL_MS || 0);
const STALL_AT = Number(__ENV.STALL_AT || 5);
const WARMUP_SECONDS = 5;
const SALE_DELAY_SECONDS = 12;

const created = new Counter('orders_created');
const soldOut = new Counter('checkout_sold_out');
const unexpected = new Counter('checkout_unexpected');
const queueCalls = new Counter('queue_calls');
/** From the drop's start to this buyer's order being created: what the customer actually waits. */
const timeToOrder = new Trend('time_to_order', true);
/** From the drop's start to this buyer's pass: time spent in the line. */
const timeInLine = new Trend('time_in_line', true);

export const options = {
  setupTimeout: '10m',
  batchPerHost: 50,
  scenarios: {
    buyers: { executor: 'per-vu-iterations', vus: BUYERS, iterations: 1, maxDuration: '3m', exec: 'buy' },
    ...(STALL_MS > 0 ? { stall: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '3m', exec: 'stall' } } : {}),
  },
  thresholds: {
    // Always true: only here so the summary lists these on their own.
    'http_req_duration{name:checkout}': ['p(99)>=0'],
    'http_req_duration{name:queue}': ['p(99)>=0'],
    'http_reqs{name:checkout}': ['count>=0'],
    'http_reqs{name:queue}': ['count>=0'],
  },
};

export function setup() {
  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const productId = createProduct(admin, STOCK);
  const tokens = loginMany(BUYERS);
  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);
    const cleared = http.batch(
      chunk.map((t) => ['DELETE', `${BASE_URL}/cart`, null, { headers: { Authorization: `Bearer ${t}` } }]),
    );
    if (cleared.some((r) => r.status !== 204)) throw new Error('could not empty carts');
    const filled = http.batch(
      chunk.map((t) => ['PUT', `${BASE_URL}/cart/items/${productId}`, JSON.stringify({ quantity: 1 }), auth(t)]),
    );
    if (filled.some((r) => r.status !== 200)) throw new Error('could not fill carts');
  }
  // Last, so logging 1,000 buyers in doesn't eat into the countdown.
  const startsAt = Date.now() + SALE_DELAY_SECONDS * 1000;
  const drop = http.post(
    `${BASE_URL}/drops`,
    JSON.stringify({
      productId,
      startsAt: new Date(startsAt).toISOString(),
      admitPerSecond: ADMIT,
      maxPerCustomer: 1,
      ...(MODE === 'window' ? { maxShoppers: SHOPPERS } : {}),
    }),
    auth(admin),
  );
  if (drop.status !== 201) throw new Error(`create drop: ${drop.status} ${drop.body}`);
  return { productId, dropId: drop.json('id'), tokens, startsAt };
}

function warmUp() {
  sleep(((__VU - 1) % 200) * (WARMUP_SECONDS / 200));
  for (let attempt = 0; attempt < 5; attempt++) {
    if (http.get(`${BASE_URL}/health/live`, { tags: { name: 'warmup' } }).status === 200) return;
    sleep(0.2 + Math.random() * 0.3);
  }
}

export function buy(data) {
  // Not __VU: the stall scenario takes a VU number too. One iteration per buyer, so this is 0..BUYERS-1.
  const token = data.tokens[exec.scenario.iterationInTest];
  warmUp();
  sleep(Math.max(0, (data.startsAt - Date.now()) / 1000));

  // The line: repeat the same call until the ticket is called. Wait as long as the API's estimate says, 0.5–5 s.
  let pass;
  for (let i = 0; i < 200 && !pass; i++) {
    const res = http.post(`${BASE_URL}/drops/${data.dropId}/queue`, null, {
      headers: { Authorization: `Bearer ${token}` },
      tags: { name: 'queue' },
    });
    queueCalls.add(1);
    if (res.status !== 200) {
      unexpected.add(1);
      console.warn(`queue: status=${res.status} ${String(res.body).slice(0, 150)}`);
      sleep(1);
      continue;
    }
    const status = res.json();
    if (status.admitted) pass = status.pass;
    else sleep(Math.min(5, Math.max(0.5, status.etaSeconds)));
  }
  if (!pass) return;
  timeInLine.add(Date.now() - data.startsAt);

  const res = http.post(`${BASE_URL}/checkout`, JSON.stringify({ dropPass: pass }), {
    ...auth(token, { 'Idempotency-Key': `e5-drop-${data.dropId}-buyer-${__VU}` }),
    tags: { name: 'checkout' },
  });
  if (res.status === 201) {
    created.add(1);
    timeToOrder.add(Date.now() - data.startsAt);
  } else if (res.status === 409 && res.json('error') === 'out_of_stock') {
    soldOut.add(1);
  } else {
    unexpected.add(1);
    console.warn(`checkout: status=${res.status} error=${res.error_code} ${String(res.body).slice(0, 150)}`);
  }
}

/** The deliberate jam: hold the stock row locked for STALL_MS, STALL_AT seconds into the sale. */
export function stall(data) {
  sleep(Math.max(0, (data.startsAt + STALL_AT * 1000 - Date.now()) / 1000));
  const res = http.post(`${BASE_URL}/lab/hold-stock-lock?productId=${data.productId}&ms=${STALL_MS}`, null, {
    tags: { name: 'stall' },
    timeout: '30s',
  });
  console.log(JSON.stringify({ result: 'stall', status: res.status, body: res.body, atMs: Date.now() - data.startsAt }));
}

export function teardown(data) {
  const left = available(data.productId);
  console.log(
    JSON.stringify({ result: 'e5-drop', mode: MODE, admitPerSecond: ADMIT, shoppers: MODE === 'window' ? SHOPPERS : null, stallMs: STALL_MS, buyers: BUYERS, dropId: data.dropId, initialStock: STOCK, finalStock: left }),
  );
}
