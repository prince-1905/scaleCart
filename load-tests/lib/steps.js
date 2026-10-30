/**
 * Builds an open-model "step test": a sequence of constant-arrival-rate stages.
 *
 * Open model = k6 starts N requests per second no matter how slow the server is,
 * like real users. (A closed model — fixed VUs waiting for responses — slows down
 * together with the server and hides overload.)
 *
 * Each step is its own scenario, so the summary reports latency, errors and
 * dropped iterations per step. `dropped_iterations > 0` means k6 could not start
 * requests on time: that step's result is invalid (or the system is saturated).
 */
export const HOLD_SECONDS = Number(__ENV.HOLD || 20);
const GAP_SECONDS = 3;

export function stepScenarios({
  rates,
  exec = 'default',
  warmupRate,
  warmupSeconds = 10,
  preAllocatedVUs = 50,
  maxVUs = 2000,
  startAt = 0,
}) {
  const scenarios = {};
  const thresholds = {};
  let t = startAt;

  if (warmupRate) {
    scenarios.warmup = {
      executor: 'constant-arrival-rate',
      rate: warmupRate,
      timeUnit: '1s',
      duration: `${warmupSeconds}s`,
      startTime: `${t}s`,
      preAllocatedVUs,
      maxVUs,
      exec,
    };
    t += warmupSeconds + GAP_SECONDS;
  }

  for (const rate of rates) {
    const name = `${exec}_rate_${rate}`;
    scenarios[name] = {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: `${HOLD_SECONDS}s`,
      startTime: `${t}s`,
      preAllocatedVUs,
      maxVUs,
      exec,
    };
    // Always-true thresholds: they only make k6 report these per-step sub-metrics.
    thresholds[`http_reqs{scenario:${name}}`] = ['count>=0'];
    thresholds[`http_req_duration{scenario:${name}}`] = ['p(99)>=0'];
    thresholds[`http_req_failed{scenario:${name}}`] = ['rate>=0'];
    thresholds[`dropped_iterations{scenario:${name}}`] = ['count>=0'];
    t += HOLD_SECONDS + GAP_SECONDS;
  }

  return { scenarios, thresholds, endsAt: t };
}

export function merge(...parts) {
  return parts.reduce(
    (acc, p) => ({
      scenarios: { ...acc.scenarios, ...p.scenarios },
      thresholds: { ...acc.thresholds, ...p.thresholds },
    }),
    { scenarios: {}, thresholds: {} },
  );
}

/** "500,1000" or "500;1000" (run.ps1's -K6Env splits on commas, so lists inside it use ";"). */
export function rates(envValue, fallback) {
  return (envValue || fallback).split(/[,;]/).map(Number);
}

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8088';
