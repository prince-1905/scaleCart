/**
 * E7b — Autoscaling (HPA): ramp the load up, hold, drop it, and see what the API pods do.
 *
 * Product reads (cached, cheap per request) at an open-model arrival rate:
 *   0:00–0:30   100/s      warm, 1 pod
 *   0:30–1:00   ramp to PEAK/s
 *   1:00–4:00   PEAK/s     the HPA should add pods
 *   4:00–7:00   100/s      the HPA should remove them again (after its 2 min calm window)
 * Pod counts and per-pod CPU are logged outside k6 (kubectl), per 5 s.
 *
 *   k6 run -e BASE_URL=http://localhost:8089 -e PEAK=1500 load-tests/e7-autoscale.js
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8089';
const PEAK = Number(__ENV.PEAK || 1500);
const failed = new Counter('failed_requests');

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '30s', target: PEAK },
        { duration: '3m', target: PEAK },
        { duration: '10s', target: 100 },
        { duration: '2m50s', target: 100 },
      ],
    },
  },
  thresholds: { 'http_req_duration{expected_response:true}': ['p(99)>=0'] },
};

export function setup() {
  return { started: Date.now() };
}

export default function (data) {
  const id = 1 + Math.floor(Math.random() * 2000);
  const res = http.get(`${BASE_URL}/products/${id}`, { tags: { name: 'product' }, timeout: '10s' });
  if (res.status !== 200) {
    failed.add(1);
    console.warn(`t=${((Date.now() - data.started) / 1000).toFixed(0)}s status=${res.status} error=${res.error_code}`);
  }
}
