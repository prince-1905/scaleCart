/**
 * E1 — What does a login cost, and what does a plain database read cost?
 *
 * catalog: GET /products/:id for random seeded products (a primary-key lookup in MySQL).
 *          Baseline for Phase 2: the same test again with a Redis cache in front.
 * login:   POST /auth/login. Argon2id (19 MiB, 2 passes) runs on libuv's thread pool.
 *          Hypothesis: one API instance (1 CPU) manages only tens of logins per second.
 * hol:     catalog reads at CATALOG_RATE, alone and then next to logins at
 *          HOL_LOGIN_RATE. The hashing happens off the event loop. Does it still hurt?
 *
 * Needs `SEED_PRODUCTS=200000 SEED_USERS=2000 node dist/seed.js`.
 */
import http from 'k6/http';
import { BASE_URL, HOLD_SECONDS, merge, rates, stepScenarios } from './lib/steps.js';
import { JSON_HEADERS, USER_PASSWORD, loadTestEmail } from './lib/shop.js';

const PART = __ENV.PART || 'catalog';
const PRODUCTS = Number(__ENV.PRODUCTS || 200000);
const USERS = Number(__ENV.USERS || 2000);
const CATALOG_RATE = Number(__ENV.CATALOG_RATE || 500);
const HOL_LOGIN_RATE = Number(__ENV.HOL_LOGIN_RATE || 20);

const catalogSteps = stepScenarios({
  exec: 'product',
  rates: rates(__ENV.CATALOG_RATES, '250,500,1000,1500,2000,2500'),
  warmupRate: 200,
  preAllocatedVUs: 100,
});

const loginSteps = stepScenarios({
  exec: 'login',
  rates: rates(__ENV.LOGIN_RATES, '5,10,20,30,40,60'),
  warmupRate: 5,
  preAllocatedVUs: 50,
});

const HOL_WARMUP_SECONDS = 10;
const holStart = HOL_WARMUP_SECONDS + 3;
const constant = (rate, exec, startTime, duration = `${HOLD_SECONDS}s`) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration,
  startTime,
  preAllocatedVUs: 50,
  maxVUs: 1000,
  exec,
});
const holSteps = {
  scenarios: {
    hol_warmup: constant(CATALOG_RATE, 'product', '0s', `${HOL_WARMUP_SECONDS}s`),
    catalog_alone: constant(CATALOG_RATE, 'product', `${holStart}s`),
    catalog_with_logins: constant(CATALOG_RATE, 'product', `${holStart + HOLD_SECONDS + 3}s`),
    background_logins: constant(HOL_LOGIN_RATE, 'login', `${holStart + HOLD_SECONDS + 3}s`),
  },
  thresholds: Object.fromEntries(
    ['catalog_alone', 'catalog_with_logins', 'background_logins'].flatMap((s) => [
      [`http_reqs{scenario:${s}}`, ['count>=0']],
      [`http_req_duration{scenario:${s}}`, ['p(99)>=0']],
      [`http_req_failed{scenario:${s}}`, ['rate>=0']],
      [`dropped_iterations{scenario:${s}}`, ['count>=0']],
    ]),
  ),
};

const parts = { catalog: catalogSteps, login: loginSteps, hol: holSteps };

export const options = {
  ...merge(parts[PART]),
  discardResponseBodies: true,
};

export function product() {
  const id = 1 + Math.floor(Math.random() * PRODUCTS);
  http.get(`${BASE_URL}/products/${id}`, { tags: { name: 'product' } });
}

export function login() {
  const n = 1 + Math.floor(Math.random() * USERS);
  http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: loadTestEmail(n), password: USER_PASSWORD }),
    { headers: JSON_HEADERS, tags: { name: 'login' } },
  );
}
