/**
 * E1 — Flash sale: can checkout oversell?
 *
 * One product with STOCK units. BUYERS different customers (each with the product in
 * their cart) all press "buy" at the same moment: a burst, not a steady rate.
 * Run it once per stock strategy (restart the API with STOCK_RESERVATION=...):
 *   atomic   expect exactly STOCK orders, final stock 0
 *   locking  same result, held locks longer
 *   naive    hypothesis: more than STOCK orders (overselling)
 *
 * PART=double-click: every buyer sends the same checkout twice at once with the same
 * Idempotency-Key. Expect exactly one order per buyer.
 *
 * Results: counters below + the teardown line in the .log.err file. Cross-check in
 * MySQL: SELECT COUNT(*), SUM(quantity) FROM scalecart_orders.order_items WHERE product_id = ?
 *
 * Connections are opened *before* the sale (staggered), then every buyer fires at the
 * same timestamp, like shoppers who already have the page open. Opening 1,000 new TCP
 * connections in the same instant overflows Docker Desktop's port forwarder on
 * Windows ("connection refused", k6 error 1212): a test-rig limit, not the app's.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from './lib/steps.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  auth,
  available,
  createProduct,
  login,
  loginMany,
} from './lib/shop.js';

const BUYERS = Number(__ENV.BUYERS || 1000);
// Connections open over the first WARMUP_SECONDS; the sale starts SALE_DELAY_SECONDS after setup.
const WARMUP_SECONDS = 5;
const SALE_DELAY_SECONDS = 10;
const PART = __ENV.PART || 'oversell';
const DOUBLE_CLICK = PART === 'double-click';
const STOCK = Number(__ENV.STOCK || (DOUBLE_CLICK ? BUYERS * 2 : 100));

const created = new Counter('orders_created');
const replayed = new Counter('checkout_replayed');
const soldOut = new Counter('checkout_sold_out');
const inProgress = new Counter('checkout_in_progress');
const unexpected = new Counter('checkout_unexpected');

export const options = {
  setupTimeout: '10m',
  batchPerHost: 50,
  scenarios: {
    buyers: {
      executor: 'per-vu-iterations',
      vus: BUYERS,
      iterations: 1,
      maxDuration: '2m',
      exec: 'buy',
    },
  },
  thresholds: {
    // Always true: only here so the summary reports checkout latency on its own.
    'http_req_duration{name:checkout}': ['p(99)>=0'],
    'http_reqs{name:checkout}': ['count>=0'],
  },
};

export function setup() {
  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const productId = createProduct(admin, STOCK);
  const tokens = loginMany(BUYERS);

  // Each buyer's cart holds exactly one unit of this run's product.
  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);
    // No Content-Type on a bodyless DELETE: Fastify rejects an empty JSON body with 400.
    const cleared = http.batch(
      chunk.map((t) => ['DELETE', `${BASE_URL}/cart`, null, { headers: { Authorization: `Bearer ${t}` } }]),
    );
    if (cleared.some((r) => r.status !== 204)) throw new Error('could not empty carts');
    const res = http.batch(
      chunk.map((t) => [
        'PUT',
        `${BASE_URL}/cart/items/${productId}`,
        JSON.stringify({ quantity: 1 }),
        auth(t),
      ]),
    );
    if (res.some((r) => r.status !== 200)) throw new Error('could not fill carts');
  }
  return { productId, tokens, saleStartsAt: Date.now() + SALE_DELAY_SECONDS * 1000 };
}

/** Opens (and keeps alive) as many connections as the buyer will use, with retries. */
function warmUp(connections) {
  sleep(((__VU - 1) % 200) * (WARMUP_SECONDS / 200));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = http.batch(
      Array.from({ length: connections }, () => ['GET', `${BASE_URL}/health/live`, null, { tags: { name: 'warmup' } }]),
    );
    if (res.every((r) => r.status === 200)) return;
    sleep(0.2 + Math.random() * 0.3);
  }
  console.warn(`VU ${__VU}: could not open a connection before the sale`);
}

function record(res) {
  if (res.status === 201) {
    if (res.headers['Idempotent-Replayed'] === 'true') replayed.add(1);
    else created.add(1);
  } else if (res.status === 409) {
    if (res.json('error') === 'out_of_stock') soldOut.add(1);
    else inProgress.add(1);
  } else {
    unexpected.add(1);
    console.warn(`unexpected: status=${res.status} error=${res.error_code} ${String(res.body).slice(0, 200)}`);
  }
}

export function buy(data) {
  const token = data.tokens[__VU - 1];
  const key = `drop-${data.productId}-${__VU}`;
  const request = ['POST', `${BASE_URL}/checkout`, '{}', { ...auth(token, { 'Idempotency-Key': key }), tags: { name: 'checkout' } }];

  warmUp(DOUBLE_CLICK ? 2 : 1);
  sleep(Math.max(0, (data.saleStartsAt - Date.now()) / 1000));

  const responses = DOUBLE_CLICK ? http.batch([request, request]) : [http.request(...request)];
  responses.forEach(record);
}

export function teardown(data) {
  const left = available(data.productId);
  console.log(
    JSON.stringify({
      result: 'flash-sale',
      part: PART,
      productId: data.productId,
      buyers: BUYERS,
      initialStock: STOCK,
      finalStock: left,
      unitsTakenFromStock: STOCK - left,
    }),
  );
}
