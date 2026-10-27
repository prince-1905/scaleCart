/**
 * E0 — How fast can the test rig itself go?
 *
 * Step A hits /static-ok, answered by NGINX without touching Node: its ceiling is
 * the load generator + Docker networking, i.e. the most this laptop can measure.
 * Step B hits /lab/ping on one Node process (1 CPU): framework + proxy overhead.
 * If B tops out far below A, the bottleneck is the app, not the test rig.
 */
import http from 'k6/http';
import { BASE_URL, merge, rates, stepScenarios } from './lib/steps.js';

const staticSteps = stepScenarios({
  exec: 'staticOk',
  rates: rates(__ENV.STATIC_RATES, '2000,5000,8000,12000,16000'),
  warmupRate: 1000,
  preAllocatedVUs: 100,
});
const pingSteps = stepScenarios({
  exec: 'ping',
  rates: rates(__ENV.PING_RATES, '1000,2000,3000,4000,5000,6000'),
  warmupRate: 500,
  preAllocatedVUs: 100,
  startAt: staticSteps.endsAt,
});

export const options = {
  ...merge(staticSteps, pingSteps),
  discardResponseBodies: true,
};

export function staticOk() {
  http.get(`${BASE_URL}/static-ok`, { tags: { name: 'static-ok' } });
}

export function ping() {
  http.get(`${BASE_URL}/lab/ping`, { tags: { name: 'ping' } });
}
