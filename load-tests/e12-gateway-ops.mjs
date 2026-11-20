/**
 * E12c/d — the gateway under operations, while customers keep browsing.
 *
 *   node load-tests/e12-gateway-ops.mjs down      stop the gateway for 30 s, then start it
 *   node load-tests/e12-gateway-ops.mjs restart   `docker compose restart gateway` (a planned restart)
 *   node load-tests/e12-gateway-ops.mjs reload    change Kong's config twice through its admin API (DB-less /config)
 *   node load-tests/e12-gateway-ops.mjs jaeger    E13d: stop the tracing backend (Jaeger) for 60 s, then start it; also
 *                                                 records the memory of the traced services before, during and after
 *
 * Traffic: RATE product-page requests per second (default 100) through NGINX → Kong → shop, plus one request per
 * second for the shop's start page (/shop/, served by NGINX itself). Every answer is recorded; the script prints what
 * customers saw in each phase. Plain fetch; 10 seed users share the product-page traffic (per-user limits).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = 'http://localhost:8088';
const RATE = Number(process.env.RATE ?? 100);
const mode = process.argv[2];
if (!['down', 'restart', 'reload', 'jaeger'].includes(mode)) {
  console.error('usage: node load-tests/e12-gateway-ops.mjs <down|restart|reload|jaeger>');
  process.exit(2);
}

const t0 = performance.now();
const at = () => (performance.now() - t0) / 1000;
const log = (...a) => console.log(`${at().toFixed(1).padStart(6)} s  ${new Date().toISOString().slice(11, 23)}`, ...a);
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString().trim();

/** Every answer: [sent at s, status (0 = no answer), ms, what]. */
const answers = [];
let phase = 'before';
const phases = [];
const mark = (name) => {
  phase = name;
  phases.push([name, at()]);
  log(`── ${name}`);
};

// 10 logged-in shoppers share the traffic: anonymous requests would all count against one IP's limit (20/s).
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const tokens = [];
for (let n = 20; n < 30; n++) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `loadtest+${n}@scalecart.local`, password: env.SEED_USER_PASSWORD }),
  });
  const token = (await res.json()).accessToken;
  if (token) tokens.push(token);
}
if (tokens.length < 5) throw new Error(`only ${tokens.length} logins worked`);

let sentCount = 0;
async function one(path, what) {
  const sent = at();
  const p = phase;
  const start = performance.now();
  let status = 0;
  try {
    const headers = what === 'api' ? { authorization: `Bearer ${tokens[sentCount++ % tokens.length]}` } : {};
    const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(5_000) });
    await res.arrayBuffer();
    status = res.status;
  } catch {
    status = 0;
  }
  answers.push({ sent, status, ms: performance.now() - start, what, phase: p });
}

let running = true;
async function traffic() {
  const gap = 1000 / RATE;
  let next = performance.now();
  let n = 0;
  while (running) {
    void one(`/products/${1 + Math.floor(Math.random() * 2000)}`, 'api');
    if (++n % RATE === 0) void one('/shop/', 'static');
    next += gap;
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

function report() {
  console.log('\n| phase | from s | api: requests | api: ok | api: failed (status:count) | api ok p50 / max ms | /shop/ page ok |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, from] of phases) {
    const api = answers.filter((a) => a.phase === name && a.what === 'api');
    const ok = api.filter((a) => a.status === 200);
    const bad = api.filter((a) => a.status !== 200);
    const kinds = Object.entries(bad.reduce((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {}))
      .map(([s, c]) => `${s}:${c}`)
      .join(' ');
    const ms = ok.map((a) => a.ms).sort((x, y) => x - y);
    const st = answers.filter((a) => a.phase === name && a.what === 'static');
    console.log(
      `| ${name} | ${from.toFixed(1)} | ${api.length} | ${ok.length} | ${bad.length}${kinds ? ` (${kinds})` : ''} | ${ms.length ? `${ms[Math.floor(ms.length / 2)].toFixed(1)} / ${ms.at(-1).toFixed(1)}` : '-'} | ${st.filter((a) => a.status === 200).length} of ${st.length} |`,
    );
  }
  const failed = answers.filter((a) => a.what === 'api' && a.status !== 200).sort((x, y) => x.sent - y.sent);
  if (failed.length) log(`first failure sent at ${failed[0].sent.toFixed(2)} s, last at ${failed.at(-1).sent.toFixed(2)} s`);
}

// A real change: the shop service's read timeout. Applied through the admin API (infra/kong/reload.lua).
const RELOAD = (from, to) =>
  `docker exec scalecart-gateway-1 sh -c "sed 's/read_timeout: ${from}/read_timeout: ${to}/' /tmp/kong.yml > /tmp/kong-new.yml && ` +
  `resty /kong/reload.lua /tmp/kong-new.yml"`;

mark('before');
const flow = traffic();
await sleep(10_000);

if (mode === 'down') {
  mark('gateway stopped');
  const s = performance.now();
  sh('docker compose stop gateway');
  log(`stop took ${((performance.now() - s) / 1000).toFixed(1)} s`);
  await sleep(30_000);
  mark('gateway starting');
  const u = performance.now();
  sh('docker compose start gateway');
  log(`start command returned after ${((performance.now() - u) / 1000).toFixed(1)} s`);
  // First 200 after the start command.
  while (!answers.some((a) => a.phase === 'gateway starting' && a.what === 'api' && a.status === 200)) await sleep(50);
  const first = answers.find((a) => a.phase === 'gateway starting' && a.what === 'api' && a.status === 200);
  log(`first product page served again: request sent ${(first.sent - (u - t0) / 1000).toFixed(2)} s after the start command`);
  await sleep(10_000);
  mark('after');
} else if (mode === 'jaeger') {
  const memory = () =>
    sh('docker stats --no-stream --format "{{.Name}}={{.MemUsage}}" scalecart-api-4 scalecart-payments-1 scalecart-gateway-1')
      .split(/\r?\n/)
      .map((l) => l.replace('scalecart-', '').replace(/ \/ .*/, ''))
      .join('  ');
  log('memory before:', memory());
  mark('jaeger stopped');
  sh('docker compose stop jaeger');
  await sleep(30_000);
  log('memory after 30 s without Jaeger:', memory());
  await sleep(30_000);
  log('memory after 60 s without Jaeger:', memory());
  mark('jaeger back');
  sh('docker compose start jaeger');
  await sleep(20_000);
  log('memory 20 s after Jaeger is back:', memory());
  mark('after');
} else if (mode === 'restart') {
  mark('restarting');
  const s = performance.now();
  sh('docker compose restart gateway');
  log(`restart command returned after ${((performance.now() - s) / 1000).toFixed(1)} s`);
  await sleep(10_000);
  mark('after');
} else {
  mark('reload 1');
  log('admin API answered', sh(RELOAD('30000', '30001')));
  await sleep(10_000);
  mark('reload 2');
  log('admin API answered', sh(RELOAD('30000', '30000')));
  await sleep(10_000);
  mark('after');
}

await sleep(10_000);
running = false;
await flow;
await sleep(5_500);
report();
