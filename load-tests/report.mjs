// Turns a k6 --summary-export file into a per-step markdown table.
// Usage: node report.mjs <summary.json> <holdSeconds>
import { readFileSync } from 'node:fs';

const [file, holdArg] = process.argv.slice(2);
const hold = Number(holdArg ?? 20);
const { metrics } = JSON.parse(readFileSync(file, 'utf8'));

const scenarioOf = (key) => key.match(/\{scenario:([^}]+)\}/)?.[1];
const scenarios = [
  ...new Set(
    Object.keys(metrics)
      .filter((k) => k.startsWith('http_reqs{'))
      .map(scenarioOf)
      .filter(Boolean),
  ),
];

const targetRate = (s) => Number(s.match(/_rate_(\d+)$/)?.[1]) || null;
const group = (s) => s.replace(/_rate_\d+$/, '');
// Keep the order the steps ran in: grouped by scenario family, then by rising target rate.
scenarios.sort(
  (a, b) => group(a).localeCompare(group(b)) || (targetRate(a) ?? 0) - (targetRate(b) ?? 0),
);
const ms = (v) => (v === undefined ? '-' : v.toFixed(1));

const rows = scenarios.map((s) => {
  const reqs = metrics[`http_reqs{scenario:${s}}`] ?? {};
  const dur = metrics[`http_req_duration{scenario:${s}}`] ?? {};
  const failed = metrics[`http_req_failed{scenario:${s}}`] ?? {};
  const dropped = metrics[`dropped_iterations{scenario:${s}}`]?.count ?? 0;
  const achieved = (reqs.count ?? 0) / hold;
  return {
    scenario: s,
    target: targetRate(s) ?? '-',
    achieved: achieved.toFixed(0),
    p50: ms(dur.med),
    p95: ms(dur['p(95)']),
    p99: ms(dur['p(99)']),
    max: ms(dur.max),
    errors: `${(((failed.value ?? 0) * 100)).toFixed(2)}%`,
    dropped,
  };
});

const header = ['scenario', 'target rps', 'achieved rps', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'errors', 'dropped'];
console.log(`| ${header.join(' | ')} |`);
console.log(`|${header.map(() => '---').join('|')}|`);
for (const r of rows) {
  console.log(
    `| ${[r.scenario, r.target, r.achieved, r.p50, r.p95, r.p99, r.max, r.errors, r.dropped].join(' | ')} |`,
  );
}
console.log('\nRead it like this: a step is healthy when achieved ≈ target, dropped = 0 and p99 stays flat.');

// Latency per request name (scripts tag requests with { name } and add a threshold on it).
const named = Object.keys(metrics)
  .map((k) => k.match(/^http_req_duration\{name:([^}]+)\}$/)?.[1])
  .filter(Boolean);
if (named.length) {
  console.log('\n| request | count | p50 ms | p95 ms | p99 ms | max ms |');
  console.log('|---|---|---|---|---|---|');
  for (const n of named) {
    const dur = metrics[`http_req_duration{name:${n}}`];
    const count = metrics[`http_reqs{name:${n}}`]?.count ?? '-';
    console.log(`| ${n} | ${count} | ${ms(dur.med)} | ${ms(dur['p(95)'])} | ${ms(dur['p(99)'])} | ${ms(dur.max)} |`);
  }
}

// Custom counters defined by the script (k6's built-in metrics are skipped).
const BUILTIN = new Set(['http_reqs', 'iterations', 'data_sent', 'data_received', 'dropped_iterations']);
const counters = Object.entries(metrics).filter(
  ([k, v]) => !k.includes('{') && !BUILTIN.has(k) && v.count !== undefined && v.rate !== undefined,
);
if (counters.length) {
  console.log('');
  for (const [k, v] of counters) console.log(`${k}: ${v.count}`);
}
