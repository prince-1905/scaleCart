/**
 * E13b — find a slow part from ONE trace, without reading logs.
 *
 *   node load-tests/e13-find-slow.mjs
 *
 * Plants a problem: /lab/hold-stock-lock keeps one product's stock row locked for 3 s (like a commit stuck on a slow
 * disk, E3e). A customer then checks out that product, through Kong. The script takes the X-Trace-Id Kong returned,
 * reads the trace from Jaeger and prints the slowest steps: the answer should be the stock UPDATE waiting for the lock.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = 'http://localhost:8088';
const HOLD_MS = Number(process.env.HOLD_MS ?? 3000);

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });

const login = await (await post('/auth/login', { email: 'loadtest+51@scalecart.local', password: env.SEED_USER_PASSWORD })).json();
const auth = { authorization: `Bearer ${login.accessToken}` };
await fetch(`${BASE}/cart`, { method: 'DELETE', headers: auth });
const productId = 1000 + Math.floor(Math.random() * 150_000);
await fetch(`${BASE}/cart/items/${productId}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ quantity: 1 }) });

// The planted problem: lock the product's stock row for HOLD_MS (not awaited), then a customer checks out.
const hold = fetch(`${BASE}/lab/hold-stock-lock?productId=${productId}&ms=${HOLD_MS}`, { method: 'POST' });
await sleep(200);
const started = performance.now();
const checkout = await post('/checkout', {}, { ...auth, 'idempotency-key': randomUUID() });
const ms = performance.now() - started;
const traceId = checkout.headers.get('x-trace-id');
console.log(`checkout → ${checkout.status} in ${ms.toFixed(0)} ms, trace ${traceId}`);
await hold;

// Read the trace back (spans arrive in batches) and list the slowest steps that have no children (the real work).
let spans = [];
for (let i = 0; i < 60 && !spans.some((s) => s.service === 'shop-api'); i++) {
  await sleep(500);
  const r = await fetch(`http://localhost:16686/api/traces/${traceId}`);
  const t = r.ok ? (await r.json()).data?.[0] : undefined;
  if (t) {
    const svc = Object.fromEntries(Object.entries(t.processes).map(([k, v]) => [k, v.serviceName]));
    spans = t.spans.map((s) => ({ ...s, service: svc[s.processID] }));
  }
}
const parents = new Set(spans.flatMap((s) => (s.references ?? []).map((r) => r.spanID)));
const leaves = spans.filter((s) => !parents.has(s.spanID)).sort((a, b) => b.duration - a.duration);
const statement = (s) => s.tags?.find((t) => t.key === 'db.query.text' || t.key === 'db.statement')?.value ?? '';
console.log(`${spans.length} spans; slowest steps:`);
for (const s of leaves.slice(0, 3)) {
  console.log(`  ${(s.duration / 1000).toFixed(1).padStart(8)} ms  ${s.service}  ${s.operationName}  ${statement(s).replace(/\s+/g, ' ').slice(0, 90)}`);
}
