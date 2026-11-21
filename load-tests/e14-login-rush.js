/**
 * E14a — a login rush next to shoppers: does checking passwords slow down browsing and checkout?
 *
 *   shoppers  SHOPPERS logged-in users, together SHOPPER_RATE req/s (product page, search, cart)
 *   logins    LOGIN_RATE successful logins per second (POST /auth/login), spread over many seed users. Each one
 *             runs Argon2 on purpose (~50 ms of CPU), like the minutes before a drop opens.
 *
 * Run it against the stack before the identity split (logins inside the shop) and after (logins in apps/identity).
 * The login rate limit (10 per IP, then 1 per 5 s) must be lifted for the run: everything comes from one IP.
 *
 *   ./load-tests/run.ps1 -Script e14-login-rush.js -K6Env LOGIN_RATE=30
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { BASE_URL } from './lib/steps.js';
import { auth, JSON_HEADERS, loadTestEmail, loginMany, USER_PASSWORD } from './lib/shop.js';

const SHOPPERS = Number(__ENV.SHOPPERS || 50);
const SHOPPER_RATE = Number(__ENV.SHOPPER_RATE || 50);
const LOGIN_RATE = Number(__ENV.LOGIN_RATE || 0);
const DURATION = __ENV.DURATION || '60s';
/** Seed users 100..1999 log in during the rush (loadtest+10/+11 have 2FA on; the shoppers are 1..~55). */
const FIRST_LOGIN_USER = 100;
const LOGIN_USERS = 1900;

const shopperErrors = new Counter('shopper_errors');
const shopperLimited = new Counter('shopper_429');
const loginOk = new Counter('login_ok');
const loginLimited = new Counter('login_429');
const loginErrors = new Counter('login_errors');

export const options = {
  setupTimeout: '180s',
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
    ...(LOGIN_RATE > 0 && {
      logins: {
        executor: 'constant-arrival-rate',
        exec: 'login',
        rate: LOGIN_RATE,
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: 100,
        maxVUs: 2000,
      },
    }),
  },
  thresholds: {
    'http_req_duration{who:shopper}': ['p(99)>=0'],
    'http_req_duration{who:login}': ['p(99)>=0'],
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  // Seed users with 2FA on get a challenge instead of a token: skip them.
  const tokens = loginMany(SHOPPERS + 5).filter(Boolean).slice(0, SHOPPERS);
  if (tokens.length < SHOPPERS) throw new Error(`only ${tokens.length} of ${SHOPPERS} shoppers got a token`);
  return { shoppers: tokens };
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

export function login() {
  const email = loadTestEmail(FIRST_LOGIN_USER + Math.floor(Math.random() * LOGIN_USERS));
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password: USER_PASSWORD }), {
    headers: JSON_HEADERS,
    tags: { who: 'login', name: 'login' },
    timeout: '30s',
  });
  if (res.status === 200) loginOk.add(1);
  else if (res.status === 429) loginLimited.add(1);
  else loginErrors.add(1);
}
