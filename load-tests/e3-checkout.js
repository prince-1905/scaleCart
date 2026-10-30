/**
 * E3 — Checkout with the confirmation email inside the request (NOTIFY_MODE=sync) vs
 * through the outbox + RabbitMQ + worker (NOTIFY_MODE=outbox).
 *
 * Each iteration = one shopper: put 1 unit in the cart, then check out.
 * PART=steps   stepped rates (CHECKOUT_RATES), for latency and capacity
 * PART=steady  RATE checkouts/s for DURATION seconds, used while the runner breaks
 *              things (mail server paused, worker killed, RabbitMQ restarted)
 *
 * Every VU uses its own user, so no two in-flight iterations share a cart.
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { BASE_URL, HOLD_SECONDS, rates, stepScenarios } from './lib/steps.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, auth, createProduct, login, loginMany } from './lib/shop.js';

const PART = __ENV.PART || 'steps';
const USERS = Number(__ENV.USERS || 400);
const RATE = Number(__ENV.RATE || 30);
const DURATION = Number(__ENV.DURATION || 90);

const created = new Counter('checkout_created');
const failed = new Counter('checkout_failed');

function steps() {
  const s = stepScenarios({
    exec: 'buy',
    rates: rates(__ENV.CHECKOUT_RATES, '25,50,100,150,200'),
    warmupRate: 10,
    preAllocatedVUs: Math.min(50, USERS),
    maxVUs: USERS,
  });
  // Checkout latency per step on its own (each iteration also makes a cart request).
  for (const name of Object.keys(s.scenarios).filter((n) => n !== 'warmup')) {
    s.thresholds[`http_req_duration{scenario:${name},name:checkout}`] = ['p(99)>=0'];
    s.thresholds[`http_req_failed{scenario:${name},name:checkout}`] = ['rate>=0'];
  }
  return { scenarios: s.scenarios, thresholds: s.thresholds };
}

function steady() {
  return {
    scenarios: {
      steady: {
        executor: 'constant-arrival-rate',
        rate: RATE,
        timeUnit: '1s',
        duration: `${DURATION}s`,
        preAllocatedVUs: Math.min(50, USERS),
        maxVUs: USERS,
        exec: 'buy',
      },
    },
    thresholds: {
      'http_req_duration{name:checkout}': ['p(99)>=0'],
      'http_reqs{name:checkout}': ['count>=0'],
    },
  };
}

export const options = {
  ...(PART === 'steady' ? steady() : steps()),
  setupTimeout: '10m',
  batchPerHost: 50,
};

export function setup() {
  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const productId = createProduct(admin, 10_000_000, 1999);
  const tokens = loginMany(USERS);
  // Earlier experiments leave sold-out products in these users' carts; start empty.
  for (let i = 0; i < tokens.length; i += 100) {
    const res = http.batch(
      tokens.slice(i, i + 100).map((t) => ['DELETE', `${BASE_URL}/cart`, null, { headers: { Authorization: `Bearer ${t}` } }]),
    );
    if (res.some((r) => r.status !== 204)) throw new Error('could not empty carts');
  }
  return { productId, tokens };
}

export function buy(data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  http.put(`${BASE_URL}/cart/items/${data.productId}`, JSON.stringify({ quantity: 1 }), {
    ...auth(token),
    tags: { name: 'cart' },
  });
  const res = http.post(`${BASE_URL}/checkout`, '{}', {
    ...auth(token, { 'Idempotency-Key': `e3-${__VU}-${__ITER}-${Date.now()}` }),
    tags: { name: 'checkout' },
  });
  if (res.status === 201) created.add(1);
  else failed.add(1, { status: String(res.status) });
}

export function teardown(data) {
  console.log(JSON.stringify({ result: 'e3-checkout', part: PART, productId: data.productId, holdSeconds: HOLD_SECONDS }));
}
