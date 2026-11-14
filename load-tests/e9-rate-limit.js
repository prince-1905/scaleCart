/**
 * E9 — Rate limiting: does one greedy client still hurt everyone else?
 *
 * Two groups at the same time, open model (arrival rates, not "wait for the answer"):
 *   shoppers  SHOPPERS logged-in users, together SHOPPER_RATE req/s: product page, search, cart
 *   attacker  ONE logged-in user sending ATTACK_RATE req/s of uncached searches (a scraper)
 * Run it with the limiter on and off (RATE_LIMIT_ENABLED on the API) and compare the shoppers.
 *
 * Setup logs in SHOPPERS + 1 users from one IP: give the API a roomy auth bucket for this
 * experiment (RATE_LIMIT_AUTH=1000:100), or setup itself gets 429.
 *
 *   ./load-tests/run.ps1 -Script e9-rate-limit.js -K6Env ATTACK_RATE=1500
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { BASE_URL } from './lib/steps.js';
import { auth, loginMany } from './lib/shop.js';

const SHOPPERS = Number(__ENV.SHOPPERS || 50);
const SHOPPER_RATE = Number(__ENV.SHOPPER_RATE || 50);
const ATTACK_RATE = Number(__ENV.ATTACK_RATE || 1500);
const DURATION = __ENV.DURATION || '60s';

const shopperErrors = new Counter('shopper_errors');
const shopperLimited = new Counter('shopper_429');
const attackerAllowed = new Counter('attacker_200');
const attackerLimited = new Counter('attacker_429');
const attackerOther = new Counter('attacker_other');

export const options = {
  setupTimeout: '120s',
  scenarios: {
    shoppers: {
      executor: 'constant-arrival-rate',
      exec: 'shopper',
      rate: SHOPPER_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 100,
      maxVUs: 1000,
    },
    ...(ATTACK_RATE > 0 && { attacker: {
      executor: 'constant-arrival-rate',
      exec: 'attacker',
      rate: ATTACK_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 300,
      maxVUs: 3000,
    } }),
  },
  // Thresholds that always pass: they make k6 print the per-group latency lines.
  thresholds: {
    'http_req_duration{who:shopper}': ['p(99)>=0'],
    'http_req_duration{who:attacker}': ['p(99)>=0'],
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  const tokens = loginMany(SHOPPERS + 1);
  return { shoppers: tokens.slice(0, SHOPPERS), attacker: tokens[SHOPPERS] };
}

const pick = (n) => 1 + Math.floor(Math.random() * n);

export function shopper(data) {
  const token = data.shoppers[pick(SHOPPERS) - 1];
  const step = Math.random();
  const res =
    step < 0.5
      ? http.get(`${BASE_URL}/products/${pick(2000)}`, { ...auth(token), tags: { who: 'shopper', name: 'product' }, timeout: '10s' })
      : step < 0.8
        ? http.get(`${BASE_URL}/products/search?minPriceCents=${pick(50000)}&sort=price_asc&limit=20`, {
            ...auth(token), tags: { who: 'shopper', name: 'search' }, timeout: '10s',
          })
        : http.get(`${BASE_URL}/cart`, { ...auth(token), tags: { who: 'shopper', name: 'cart' }, timeout: '10s' });
  if (res.status === 429) shopperLimited.add(1);
  else if (res.status !== 200) shopperErrors.add(1);
}

export function attacker(data) {
  const res = http.get(`${BASE_URL}/products/search?minPriceCents=${pick(50000)}&sort=price_asc&limit=20`, {
    ...auth(data.attacker),
    tags: { who: 'attacker', name: 'search' },
    timeout: '10s',
  });
  if (res.status === 200) attackerAllowed.add(1);
  else if (res.status === 429) attackerLimited.add(1);
  else attackerOther.add(1);
}
