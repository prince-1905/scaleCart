/**
 * E7a — Do customers notice a rolling update?
 *
 * Steady traffic (RATE requests/s for DURATION) to a cheap read, while something outside k6
 * replaces the API pods (`kubectl rollout restart deployment/api`). Every request that isn't a
 * 200 is counted and logged with its time, so failures can be matched to the moment pods stopped.
 *
 *   k6 run -e BASE_URL=http://localhost:8089 -e RATE=200 -e DURATION=60s load-tests/e7-rollout.js
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8089';
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '60s';

const failed = new Counter('failed_requests');
const ok = new Counter('ok_requests');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
  },
  thresholds: { 'http_req_duration{expected_response:true}': ['p(99)>=0'] },
};

export function setup() {
  return { started: Date.now() };
}

export default function (data) {
  // A product page read: cheap, so the test measures the rollout, not the API's capacity.
  const id = 1 + Math.floor(Math.random() * 2000);
  const res = http.get(`${BASE_URL}/products/${id}`, { tags: { name: 'product' }, timeout: '10s' });
  if (res.status === 200) {
    ok.add(1);
  } else {
    failed.add(1);
    const t = ((Date.now() - data.started) / 1000).toFixed(1);
    console.warn(`t=${t}s status=${res.status} error=${res.error_code} ${res.error || ''}`);
  }
}
