/**
 * E16a — does the read replica take load off the primary? Run once with READ_REPLICA=on, once with off.
 *
 *   browse     BROWSE_RATE/s  GET /products?after=<random>&limit=20   (catalog list: replica when on)
 *   dashboard  STATS_RATE/s   GET /admin/orders/stats                  (a full scan of ~70k orders: replica when on)
 *   history    HISTORY_RATE/s GET /orders?limit=20                     (own orders: replica when caught up)
 *   checkout   CHECKOUT_RATE/s "Buy now" of 1 unit                      (always the primary: the latency we protect)
 *
 *   ./load-tests/run.ps1 -Script e16-offload.js -K6Env STATS_RATE=10
 *
 * Needs the lab admin (LAB_ADMIN_PASSWORD in .env) and logins for 50 load-test users (lift RATE_LIMIT_AUTH).
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { BASE_URL } from './lib/steps.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, JSON_HEADERS, USER_PASSWORD, auth, createProduct, loadTestEmail, login } from './lib/shop.js';

const DURATION = __ENV.DURATION || '60s';
const BROWSE_RATE = Number(__ENV.BROWSE_RATE || 100);
const STATS_RATE = Number(__ENV.STATS_RATE || 10);
const HISTORY_RATE = Number(__ENV.HISTORY_RATE || 50);
const CHECKOUT_RATE = Number(__ENV.CHECKOUT_RATE || 5);
const USERS = 50;

const errors = new Counter('e16_errors');

const scenario = (exec, rate) => ({
  executor: 'constant-arrival-rate',
  exec,
  rate,
  timeUnit: '1s',
  duration: DURATION,
  preAllocatedVUs: Math.max(10, rate),
  maxVUs: rate * 20 + 20,
});

export const options = {
  setupTimeout: '180s',
  scenarios: {
    browse: scenario('browse', BROWSE_RATE),
    dashboard: scenario('dashboard', STATS_RATE),
    history: scenario('history', HISTORY_RATE),
    checkout: scenario('checkout', CHECKOUT_RATE),
  },
  thresholds: {
    'http_req_duration{name:browse}': ['p(99)>=0'],
    'http_req_duration{name:stats}': ['p(99)>=0'],
    'http_req_duration{name:history}': ['p(99)>=0'],
    'http_req_duration{name:checkout}': ['p(99)>=0'],
    'http_req_failed{name:checkout}': ['rate>=0'],
  },
};

export function setup() {
  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  // Users 100..149: some low-numbered seed users have 2FA on (their login answers with a code challenge).
  const users = [];
  for (let n = 100; users.length < USERS && n < 400; n++) {
    const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email: loadTestEmail(n), password: USER_PASSWORD }), {
      headers: JSON_HEADERS,
      tags: { name: 'setup-login' },
    });
    const token = res.status === 200 ? res.json('accessToken') : null;
    if (token) users.push(token);
  }
  if (users.length < USERS) throw new Error(`only ${users.length} users logged in`);
  const productId = createProduct(admin, 1_000_000, 100);
  return { admin, users, productId };
}

const user = (data) => data.users[Math.floor(Math.random() * data.users.length)];
const check = (name, res, ok = 200) => {
  if (res.status !== ok) errors.add(1, { name, status: String(res.status) });
};

export function browse(data) {
  const after = Math.floor(Math.random() * 199_000);
  check('browse', http.get(`${BASE_URL}/products?after=${after}&limit=20`, { ...auth(user(data)), tags: { name: 'browse' } }));
}

export function dashboard(data) {
  check('stats', http.get(`${BASE_URL}/admin/orders/stats`, { ...auth(data.admin), tags: { name: 'stats' } }));
}

export function history(data) {
  check('history', http.get(`${BASE_URL}/orders?limit=20`, { ...auth(user(data)), tags: { name: 'history' } }));
}

export function checkout(data) {
  const headers = { ...auth(user(data)).headers, 'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  check(
    'checkout',
    http.post(`${BASE_URL}/checkout`, JSON.stringify({ buyNow: { productId: data.productId, quantity: 1 } }), { headers, tags: { name: 'checkout' } }),
    201,
  );
}
