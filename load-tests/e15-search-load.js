/**
 * E15b — search under load, MySQL FULLTEXT vs OpenSearch (run once per SEARCH_ENGINE):
 *   search   RATE searches/s over all 200k products (scope=all; uncached): 1–3 real words from the catalog's own vocabulary
 *   probe    20 req/s of GET /cart (a MySQL read in another database on the same server): does search load slow it?
 * Logged-in users (search is public, but per-IP limits would cap one load generator).
 *
 *   ./load-tests/run.ps1 -Script e15-search-load.js -K6Env RATE=200
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { BASE_URL } from './lib/steps.js';
import { auth, loginMany } from './lib/shop.js';

const RATE = Number(__ENV.RATE || 50);
const USERS = Number(__ENV.USERS || 50);
const DURATION = __ENV.DURATION || '60s';

// The seed's vocabulary (apps/api/src/seed.ts), so every query has real matches.
const COLORS = ['black', 'white', 'red', 'blue', 'green', 'grey', 'navy', 'olive', 'sand', 'brown', 'pink', 'yellow', 'orange', 'purple', 'teal'];
const MATERIALS = ['cotton', 'wool', 'leather', 'denim', 'linen', 'canvas', 'suede', 'nylon', 'cashmere', 'fleece', 'silk', 'bamboo'];
const NOUNS = ['sneaker', 'boot', 'jacket', 'hoodie', 'shirt', 'backpack', 'cap', 'scarf', 'sweater', 'jeans', 'sandal', 'coat', 'wallet', 'belt', 'beanie', 'glove', 'tote', 'vest', 'parka', 'loafer', 'shorts', 'blazer', 'duffel', 'watch', 'sunglasses'];
const any = (list) => list[Math.floor(Math.random() * list.length)];
function query() {
  const r = Math.random();
  if (r < 0.4) return any(NOUNS); // "sneaker"
  if (r < 0.8) return `${any(COLORS)} ${any(NOUNS)}`; // "black sneaker"
  return `${any(COLORS)} ${any(MATERIALS)} ${any(NOUNS)}`; // "black leather boot"
}

const searchErrors = new Counter('search_errors');
const searchFallbacks = new Counter('search_fallbacks');
const probeErrors = new Counter('probe_errors');

export const options = {
  setupTimeout: '180s',
  scenarios: {
    search: { executor: 'constant-arrival-rate', exec: 'search', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 100, maxVUs: 2000 },
    probe: { executor: 'constant-arrival-rate', exec: 'probe', rate: 20, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 20, maxVUs: 200 },
  },
  thresholds: { 'http_req_duration{who:search}': ['p(99)>=0'], 'http_req_duration{who:probe}': ['p(99)>=0'] },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  const tokens = loginMany(USERS + 5).filter(Boolean).slice(0, USERS);
  if (tokens.length < USERS) throw new Error(`only ${tokens.length} of ${USERS} users got a token`);
  return { tokens };
}

const tokenOf = (data) => data.tokens[Math.floor(Math.random() * data.tokens.length)];

export function search(data) {
  const res = http.get(`${BASE_URL}/products/search?q=${encodeURIComponent(query())}&scope=all&limit=10`, {
    ...auth(tokenOf(data)),
    tags: { who: 'search', name: 'search' },
    timeout: '10s',
  });
  if (res.status !== 200) searchErrors.add(1);
  else if (res.headers['X-Search-Source'] === 'mysql-fallback') searchFallbacks.add(1);
}

export function probe(data) {
  const res = http.get(`${BASE_URL}/cart`, { ...auth(tokenOf(data)), tags: { who: 'probe', name: 'cart' }, timeout: '10s' });
  if (res.status !== 200) probeErrors.add(1);
}
