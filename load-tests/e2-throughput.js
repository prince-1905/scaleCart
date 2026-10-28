/**
 * E2 — One endpoint, stepped open-model rates. Used for the cache, adapter and scaling
 * experiments, where the *server* configuration changes between runs, not the script.
 *
 * TARGET=ping     GET /lab/ping            framework + network overhead only
 * TARGET=product  GET /products/:id        random id in 1..PRODUCTS (cache on or off: CACHE_ENABLED)
 *                                          PRODUCTS=1000 = a "hot" set (popular items during a drop)
 * TARGET=login    POST /auth/login         Argon2id, random seeded user
 *
 *   ./load-tests/run.ps1 -Script e2-throughput.js -K6Env TARGET=product,PRODUCTS=1000,RATES=500,1000,2000
 */
import http from 'k6/http';
import { BASE_URL, merge, rates, stepScenarios } from './lib/steps.js';
import { JSON_HEADERS, USER_PASSWORD, loadTestEmail } from './lib/shop.js';

const TARGET = __ENV.TARGET || 'product';
const PRODUCTS = Number(__ENV.PRODUCTS || 200000);
const USERS = Number(__ENV.USERS || 2000);

const DEFAULT_RATES = {
  ping: '1000,2000,3000,4000,5000,6000',
  product: '500,1000,2000,3000,4000,5000',
  login: '10,20,40,60,80,100',
};
const WARMUP = { ping: 500, product: 200, login: 5 };

export const options = {
  ...merge(
    stepScenarios({
      exec: TARGET,
      rates: rates(__ENV.RATES && __ENV.RATES.replace(/;/g, ','), DEFAULT_RATES[TARGET]),
      warmupRate: WARMUP[TARGET],
      preAllocatedVUs: TARGET === 'login' ? 50 : 200,
    }),
  ),
  discardResponseBodies: true,
};

export function ping() {
  http.get(`${BASE_URL}/lab/ping`, { tags: { name: 'ping' } });
}

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
