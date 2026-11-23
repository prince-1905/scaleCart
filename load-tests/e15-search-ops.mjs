/**
 * E15e/f — search while operating the search engine. Traffic: RATE searches/s (default 50) from 10 logged-in users
 * over all 200k products; every answer's status, time and X-Search-Source is recorded.
 *
 *   node load-tests/e15-search-ops.mjs down      stop OpenSearch for 30 s, then start it (fallback to MySQL, then back)
 *   node load-tests/e15-search-ops.mjs reindex   rebuild the whole index (docker compose run --rm migrate node dist/reindex.js)
 */
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = 'http://localhost:8088';
const RATE = Number(process.env.RATE ?? 50);
const mode = process.argv[2];
if (!['down', 'reindex'].includes(mode)) {
  console.error('usage: node load-tests/e15-search-ops.mjs <down|reindex>');
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const t0 = performance.now();
const at = () => (performance.now() - t0) / 1000;
const log = (...a) => console.log(`${at().toFixed(1).padStart(6)} s  ${new Date().toISOString().slice(11, 23)}`, ...a);
// Async on purpose: a blocking execSync froze the traffic generator while docker worked, then fired every "missed"
// request at once (found in E15f; it distorted the operation phases of E12/E14 measured with this script).
const sh = (cmd) =>
  new Promise((ok, fail) => exec(cmd, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? fail(err) : ok(stdout.toString().trim()))));

const tokens = [];
for (let n = 40; tokens.length < 10 && n < 80; n++) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `loadtest+${n}@scalecart.local`, password: env.SEED_USER_PASSWORD }) });
  const tk = (await r.json()).accessToken;
  if (tk) tokens.push(tk);
}
const WORDS = ['sneaker', 'black boot', 'wool sweater', 'leather jacket', 'blue denim jeans', 'canvas tote', 'red cap', 'suede loafer'];

const answers = [];
let phase = 'before';
const phases = [];
const mark = (name) => {
  phase = name;
  phases.push([name, at()]);
  log(`── ${name}`);
};
let sent = 0;
async function one() {
  const p = phase;
  const s = performance.now();
  const q = WORDS[sent % WORDS.length];
  const token = tokens[sent++ % tokens.length];
  try {
    const res = await fetch(`${BASE}/products/search?q=${encodeURIComponent(q)}&scope=all&limit=10`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    await res.arrayBuffer();
    answers.push({ phase: p, status: res.status, source: res.headers.get('x-search-source') ?? '-', ms: performance.now() - s });
  } catch {
    answers.push({ phase: p, status: 0, source: '-', ms: performance.now() - s });
  }
}
let running = true;
async function traffic() {
  let next = performance.now();
  while (running) {
    void one();
    next += 1000 / RATE;
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

mark('before');
const flow = traffic();
await sleep(10_000);
if (mode === 'down') {
  mark('opensearch stopped');
  await sh('docker compose stop opensearch');
  await sleep(30_000);
  mark('opensearch starting');
  const up = performance.now();
  await sh('docker compose start opensearch');
  while (!answers.some((a) => a.phase === 'opensearch starting' && a.source === 'opensearch')) await sleep(200);
  log(`first answer from OpenSearch again ${((performance.now() - up) / 1000).toFixed(1)} s after the start command`);
  await sleep(10_000);
  mark('after');
} else {
  mark('reindexing');
  log((await sh('docker compose run --rm migrate node dist/reindex.js')).split(/\r?\n/).filter((l) => /copied \d+ products in|alias|done in/.test(l)).join(' | '));
  mark('after');
}
await sleep(10_000);
running = false;
await flow;
await sleep(5_500);

console.log('\n| phase | from s | searches | ok | failed (status:count) | answered by | ok p50 / p95 / max ms |');
console.log('|---|---|---|---|---|---|---|');
for (const [name, from] of phases) {
  const list = answers.filter((a) => a.phase === name);
  const ok = list.filter((a) => a.status === 200);
  const bad = list.filter((a) => a.status !== 200);
  const kinds = Object.entries(Object.groupBy(bad, (a) => a.status)).map(([s, l]) => `${s}:${l.length}`).join(' ');
  const by = Object.entries(Object.groupBy(ok, (a) => a.source)).map(([s, l]) => `${s} ${l.length}`).join(', ');
  const ms = ok.map((a) => a.ms).sort((x, y) => x - y);
  const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)].toFixed(1) : '-');
  console.log(`| ${name} | ${from.toFixed(1)} | ${list.length} | ${ok.length} | ${bad.length}${kinds ? ` (${kinds})` : ''} | ${by} | ${q(0.5)} / ${q(0.95)} / ${ms.length ? ms.at(-1).toFixed(1) : '-'} |`);
}
