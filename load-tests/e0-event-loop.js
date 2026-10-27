/**
 * E0b — Waiting vs working: why the Node.js event loop matters.
 *
 * io:   each request *waits* 50 ms without blocking (like a DB call).
 *       Hypothesis: one process serves thousands of these per second; latency stays ~50 ms.
 * cpu:  each request *computes* for 5 ms on the single JS thread.
 *       Hypothesis: one process caps near 1000 / 5 = 200 req/s; past that, latency explodes.
 * hol:  "head-of-line blocking" — cheap /lab/ping requests while CPU-heavy requests
 *       run on the same process. Hypothesis: ping latency rises although ping does no work.
 */
import http from 'k6/http';
import { BASE_URL, HOLD_SECONDS, merge, rates, stepScenarios } from './lib/steps.js';

const IO_MS = Number(__ENV.IO_MS || 50);
const CPU_MS = Number(__ENV.CPU_MS || 5);
const PART = __ENV.PART || 'all';
// Background CPU load for the head-of-line test: ~50% of one process's measured capacity.
const HOL_CPU_RATE = Number(__ENV.HOL_CPU_RATE || 75);

const ioSteps = stepScenarios({
  exec: 'io',
  rates: rates(__ENV.IO_RATES, '500,1000,2000,3000'),
  warmupRate: 200,
  preAllocatedVUs: 200,
});
const cpuSteps = stepScenarios({
  exec: 'cpu',
  rates: rates(__ENV.CPU_RATES, '100,150,175,200,225,250'),
  warmupRate: 50,
  preAllocatedVUs: 100,
  startAt: PART === 'all' ? ioSteps.endsAt : 0,
});

// hol: warm up, then ping alone at 200 req/s, then the same ping rate while cpu runs at HOL_CPU_RATE.
const HOL_WARMUP_SECONDS = 10;
const holStart = (PART === 'all' ? cpuSteps.endsAt : 0) + HOL_WARMUP_SECONDS + 3;
const holSteps = {
  scenarios: {
    hol_warmup: {
      executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s',
      duration: `${HOL_WARMUP_SECONDS}s`, startTime: `${holStart - HOL_WARMUP_SECONDS - 3}s`,
      preAllocatedVUs: 50, maxVUs: 500, exec: 'ping',
    },
    ping_alone: {
      executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s',
      duration: `${HOLD_SECONDS}s`, startTime: `${holStart}s`,
      preAllocatedVUs: 50, maxVUs: 500, exec: 'ping',
    },
    ping_with_cpu_load: {
      executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s',
      duration: `${HOLD_SECONDS}s`, startTime: `${holStart + HOLD_SECONDS + 3}s`,
      preAllocatedVUs: 50, maxVUs: 500, exec: 'ping',
    },
    background_cpu_load: {
      executor: 'constant-arrival-rate', rate: HOL_CPU_RATE, timeUnit: '1s',
      duration: `${HOLD_SECONDS}s`, startTime: `${holStart + HOLD_SECONDS + 3}s`,
      preAllocatedVUs: 50, maxVUs: 500, exec: 'cpu',
    },
  },
  thresholds: Object.fromEntries(
    ['ping_alone', 'ping_with_cpu_load', 'background_cpu_load'].flatMap((s) => [
      [`http_reqs{scenario:${s}}`, ['count>=0']],
      [`http_req_duration{scenario:${s}}`, ['p(99)>=0']],
      [`http_req_failed{scenario:${s}}`, ['rate>=0']],
      [`dropped_iterations{scenario:${s}}`, ['count>=0']],
    ]),
  ),
};

const parts = {
  io: ioSteps,
  cpu: cpuSteps,
  hol: holSteps,
  all: merge(ioSteps, cpuSteps, holSteps),
};

export const options = {
  ...merge(parts[PART]),
  discardResponseBodies: true,
};

export function io() {
  http.get(`${BASE_URL}/lab/io?ms=${IO_MS}`, { tags: { name: 'io' } });
}

export function cpu() {
  http.get(`${BASE_URL}/lab/cpu?ms=${CPU_MS}`, { tags: { name: 'cpu' } });
}

export function ping() {
  http.get(`${BASE_URL}/lab/ping`, { tags: { name: 'ping' } });
}
