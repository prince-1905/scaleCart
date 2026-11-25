/**
 * E16d — browsing while the read replica fails. Traffic: 50 product-list pages/s + 10 "My orders"/s from 10 logged-in
 * users; every answer's status and time is recorded per phase. The shop's log says when it switched.
 *
 *   node load-tests/e16-replica-ops.mjs down    stop the replica container for 30 s, then start it
 *   node load-tests/e16-replica-ops.mjs pause   pause its applier for 30 s (it falls behind), then resume
 */
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = 'http://localhost:8088';
const mode = process.argv[2];
if (!['down', 'pause'].includes(mode)) {
  console.error('usage: node load-tests/e16-replica-ops.mjs <down|pause>');
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const t0 = performance.now();
const at = () => (performance.now() - t0) / 1000;
const log = (...a) => console.log(`${at().toFixed(1).padStart(6)} s  ${new Date().toISOString().slice(11, 23)}`, ...a);
// Async: a blocking execSync would freeze the traffic generator (found in E15f).
const sh = (cmd, extraEnv = {}) =>
  new Promise((ok, fail) =>
    exec(cmd, { cwd: ROOT, env: { ...process.env, ...extraEnv }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? fail(err) : ok(stdout.toString().trim()))),
  );
const onReplica = (sql) =>
  sh(`docker exec -e MYSQL_PWD scalecart-mysql-replica-1 mysql -uroot -N -e "${sql}"`, { MYSQL_PWD: env.MYSQL_ROOT_PASSWORD });

const tokens = [];
for (let n = 40; tokens.length < 10 && n < 80; n++) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `loadtest+${n}@scalecart.local`, password: env.SEED_USER_PASSWORD }) });
  const tk = (await r.json()).accessToken;
  if (tk) tokens.push(tk);
}

const answers = [];
let phase = 'before';
const phases = [];
const mark = (name) => {
  phase = name;
  phases.push([name, at()]);
  log(`── ${name}`);
};
let sent = 0;
async function one(kind) {
  const p = phase;
  const s = performance.now();
  const token = tokens[sent++ % tokens.length];
  const url = kind === 'browse' ? `${BASE}/products?after=${Math.floor(Math.random() * 199_000)}&limit=20` : `${BASE}/orders?limit=20`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    await res.arrayBuffer();
    answers.push({ phase: p, kind, status: res.status, ms: performance.now() - s });
  } catch {
    answers.push({ phase: p, kind, status: 0, ms: performance.now() - s });
  }
}
let running = true;
async function traffic() {
  let next = performance.now();
  for (let tick = 0; running; tick++) {
    void one('browse');
    if (tick % 5 === 0) void one('history');
    next += 20; // 50/s browse, 10/s history
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

const since = new Date().toISOString();
mark('before');
const flow = traffic();
await sleep(10_000);
if (mode === 'down') {
  mark('replica stopped');
  await sh('docker compose stop mysql-replica');
  await sleep(30_000);
  mark('replica starting');
  await sh('docker compose start mysql-replica');
} else {
  mark('replica paused (falling behind)');
  await onReplica('STOP REPLICA SQL_THREAD');
  await sleep(30_000);
  mark('replica resumed');
  await onReplica('START REPLICA SQL_THREAD');
}
await sleep(30_000);
running = false;
await flow;
await sleep(5_500);

console.log('\n| phase | from s | requests | ok | failed (status:count) | ok p50 / p95 / max ms |');
console.log('|---|---|---|---|---|---|');
for (const [name, from] of phases) {
  const list = answers.filter((a) => a.phase === name);
  const ok = list.filter((a) => a.status === 200);
  const bad = list.filter((a) => a.status !== 200);
  const kinds = Object.entries(Object.groupBy(bad, (a) => a.status)).map(([s, l]) => `${s}:${l.length}`).join(' ');
  const ms = ok.map((a) => a.ms).sort((x, y) => x - y);
  const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)].toFixed(1) : '-');
  console.log(`| ${name} | ${from.toFixed(1)} | ${list.length} | ${ok.length} | ${bad.length}${kinds ? ` (${kinds})` : ''} | ${q(0.5)} / ${q(0.95)} / ${ms.length ? ms.at(-1).toFixed(1) : '-'} |`);
}
const switches = (await sh(`docker compose logs api --since ${since}`))
  .split(/\r?\n/)
  .filter((l) => l.includes('read replica'))
  .map((l) => {
    const time = Number(l.match(/"time":(\d+)/)?.[1]);
    const msg = l.match(/"msg":"([^"]*)"/)?.[1];
    return `${new Date(time).toISOString().slice(11, 23)}  ${msg}`;
  });
console.log('\nshop log:\n' + switches.join('\n'));
