/**
 * E15d — freshness of the search copy: an admin renames a product (MySQL + outbox in one transaction); how long until
 * a search for the new word finds it (outbox relay → RabbitMQ → indexer → OpenSearch refresh)?
 *
 *   node load-tests/e15-freshness.mjs            20 edits, one at a time (1 s apart)
 *   node load-tests/e15-freshness.mjs burst      50 edits at once, all with the same new word
 *
 * Needs the lab admin (e15-admin@scalecart.local, LAB_ADMIN_PASSWORD in .env). Names are put back afterwards.
 * The clock starts when the PATCH answers (the edit is committed). Polls every 60 ms (under the per-IP rate limit).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = process.env.BASE_URL ?? 'http://localhost:8088';
const POLL_MS = 60;
const mode = process.argv[2] ?? 'sequential';
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'e15-admin@scalecart.local', password: env.LAB_ADMIN_PASSWORD }),
});
const token = (await login.json()).accessToken;
if (!token) throw new Error(`lab admin login failed: ${login.status}`);
const admin = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

/** A random 10-letter word: far (many letters) from any real word and from each other, so fuzzy matching can't mix them. */
const word = () => 'zq' + Array.from({ length: 8 }, () => 'bcdfghjkmnpvwx'[Math.floor(Math.random() * 14)]).join('');
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];
const ids = Array.from({ length: 50 }, () => 1 + Math.floor(Math.random() * 199_000));
const originals = new Map();
for (const id of ids) originals.set(id, (await (await fetch(`${BASE}/products/${id}`)).json()).name);

async function rename(id, name) {
  const t = performance.now();
  const r = await fetch(`${BASE}/products/${id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ name }) });
  if (r.status !== 200) throw new Error(`PATCH ${id}: ${r.status} ${await r.text()}`);
  return performance.now() - t;
}
async function total(q) {
  const r = await fetch(`${BASE}/products/search/facets?scope=all&q=${encodeURIComponent(q)}`);
  const body = await r.json();
  return { total: body.total ?? -1, source: body.source };
}

const visible = [];
const patchMs = [];
if (mode === 'burst') {
  const w = word();
  const start = performance.now();
  patchMs.push(...(await Promise.all(ids.map((id) => rename(id, `${originals.get(id)} ${w}`)))));
  const committed = performance.now();
  const seen = [];
  let last = 0;
  while (last < ids.length && performance.now() - committed < 30_000) {
    const { total: n, source } = await total(w);
    if (source !== 'opensearch') throw new Error(`answered by ${source}`);
    for (let k = last; k < n; k++) seen.push(performance.now() - committed);
    last = Math.max(last, n);
    await sleep(POLL_MS);
  }
  console.log(`50 edits sent at once: all committed after ${(committed - start).toFixed(0)} ms`);
  console.log(`visible in search, ms after the last commit: first ${seen[0]?.toFixed(0)}, 25th ${seen[24]?.toFixed(0)}, all 50 ${seen.at(-1)?.toFixed(0)} (${seen.length} of 50 seen)`);
} else {
  for (const id of ids.slice(0, 20)) {
    const w = word();
    patchMs.push(await rename(id, `${originals.get(id)} ${w}`));
    const committed = performance.now();
    let found = false;
    while (!found && performance.now() - committed < 15_000) {
      const { total: n, source } = await total(w);
      if (source !== 'opensearch') throw new Error(`answered by ${source}`);
      found = n === 1;
      if (!found) await sleep(POLL_MS);
    }
    visible.push(found ? performance.now() - committed : NaN);
    await sleep(1_000);
  }
  const ok = visible.filter((x) => !Number.isNaN(x));
  console.log(`20 edits one at a time: visible in search after p50 ${pct(ok, 0.5).toFixed(0)} ms, p95 ${pct(ok, 0.95).toFixed(0)} ms, min ${Math.min(...ok).toFixed(0)}, max ${Math.max(...ok).toFixed(0)} (${ok.length} of 20 found)`);
  console.log('each (ms):', visible.map((x) => x.toFixed(0)).join(' '));
}
console.log(`PATCH answered in p50 ${pct(patchMs, 0.5).toFixed(0)} ms, max ${Math.max(...patchMs).toFixed(0)} ms`);

await sleep(3_000); // let the admin's rate-limit bucket refill
for (const id of mode === 'burst' ? ids : ids.slice(0, 20)) {
  await rename(id, originals.get(id));
  await sleep(60);
}
console.log('names restored');
