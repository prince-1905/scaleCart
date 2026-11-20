/**
 * E12 — API gateway: what does it cost, and what does it keep away from the shop?
 *
 * Two groups at the same time, open model:
 *   shoppers  SHOPPERS logged-in users, together SHOPPER_RATE req/s (product page, search, cart; or only product
 *             pages with MIX=product, to measure the gateway's own cost)
 *   attacker  ATTACK_RATE req/s to /cart, each with a DIFFERENT forged token (random signature). A new token every
 *             time slips past NGINX's per-token limit, and the shop's own limiter never sees them: the token check
 *             comes first, so each one costs the shop a JWT check and a 401.
 *
 * Run through the gateway (BASE_URL http://localhost:8088: NGINX → Kong → shop) and around it
 * (http://localhost:8090: the lab-only "lb-direct" NGINX → shop, same flood limit, no Kong).
 *
 *   ./load-tests/run.ps1 -Script e12-gateway.js -K6Env ATTACK_RATE=1000
 *   ./load-tests/run.ps1 -Script e12-gateway.js -BaseUrl http://localhost:8090 -K6Env ATTACK_RATE=1000
 */
import encoding from 'k6/encoding';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL } from './lib/steps.js';
import { auth, loginMany } from './lib/shop.js';

const SHOPPERS = Number(__ENV.SHOPPERS || 8); // 8 logins fit the default login bucket (10 per IP)
const SHOPPER_RATE = Number(__ENV.SHOPPER_RATE || 50);
const ATTACK_RATE = Number(__ENV.ATTACK_RATE || 0);
const MIX = __ENV.MIX || 'shop';
const DURATION = __ENV.DURATION || '60s';

const shopperErrors = new Counter('shopper_errors');
// Which errors: no answer (timeout / connection), 401, 502, 503, 504, anything else.
const errorKinds = Object.fromEntries(['0', '401', '502', '503', '504', 'other'].map((k) => [k, new Counter(`shopper_err_${k}`)]));
const shopperLimited = new Counter('shopper_429');
const refusedByGateway = new Counter('attacker_401_gateway');
const refusedByShop = new Counter('attacker_401_shop');
const attackerOther = new Counter('attacker_other');
const kongProxyMs = new Trend('kong_proxy_ms', true);

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
    ...(ATTACK_RATE > 0 && {
      attacker: {
        executor: 'constant-arrival-rate',
        exec: 'attacker',
        rate: ATTACK_RATE,
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: 300,
        maxVUs: 3000,
      },
    }),
  },
  // Thresholds that always pass: they make k6 print the per-group latency lines.
  thresholds: {
    'http_req_duration{who:shopper}': ['p(99)>=0'],
    'http_req_duration{who:attacker}': ['p(99)>=0'],
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  // Seed users with 2FA turned on (loadtest+10 and +11 since E10) get a 2FA challenge instead of a token: skip them,
  // or they would send "Bearer undefined".
  const tokens = loginMany(SHOPPERS + 5).filter(Boolean).slice(0, SHOPPERS);
  if (tokens.length < SHOPPERS) throw new Error(`only ${tokens.length} of ${SHOPPERS} shoppers got a token`);
  return { shoppers: tokens };
}

const pick = (n) => 1 + Math.floor(Math.random() * n);

export function shopper(data) {
  const token = data.shoppers[pick(SHOPPERS) - 1];
  const step = MIX === 'product' ? 0 : Math.random();
  const res =
    step < 0.5
      ? http.get(`${BASE_URL}/products/${pick(2000)}`, { ...auth(token), tags: { who: 'shopper', name: 'product' }, timeout: '10s' })
      : step < 0.8
        ? http.get(`${BASE_URL}/products/search?minPriceCents=${pick(50000)}&sort=price_asc&limit=20`, {
            ...auth(token), tags: { who: 'shopper', name: 'search' }, timeout: '10s',
          })
        : http.get(`${BASE_URL}/cart`, { ...auth(token), tags: { who: 'shopper', name: 'cart' }, timeout: '10s' });
  if (res.status === 429) shopperLimited.add(1);
  else if (res.status !== 200) {
    shopperErrors.add(1);
    (errorKinds[String(res.status)] ?? errorKinds.other).add(1);
    if (__ENV.DEBUG_ERRORS) console.warn(`shopper ${res.status} ${res.request.url} ${String(res.body).slice(0, 120)}`);
  }
  const kong = res.headers['X-Kong-Proxy-Latency'];
  if (kong !== undefined) kongProxyMs.add(Number(kong));
}

const HEAD = encoding.b64encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'rawurl');
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const randomPart = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * 64)]).join('');

/** Looks like one of our tokens (right issuer, not expired), but the signature is random: a new one every time. */
function forgedToken() {
  const claims = { sub: randomPart(12), role: 'customer', iss: 'scalecart', aud: 'scalecart-api', exp: Math.floor(Date.now() / 1000) + 600 };
  return `${HEAD}.${encoding.b64encode(JSON.stringify(claims), 'rawurl')}.${randomPart(43)}`;
}

export function attacker() {
  const res = http.get(`${BASE_URL}/cart`, { ...auth(forgedToken()), tags: { who: 'attacker', name: 'cart' }, timeout: '10s' });
  if (res.status === 401) {
    if (String(res.body).includes('statusCode')) refusedByShop.add(1);
    else refusedByGateway.add(1);
  } else attackerOther.add(1);
}
