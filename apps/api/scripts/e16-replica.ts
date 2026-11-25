/**
 * E16 — the read replica, measured directly.
 *
 *   node scripts/e16-replica.ts lag [seconds=60]
 *       Every 100 ms: write a unique marker on the PRIMARY (replication_heartbeat id 2), then poll the REPLICA back to back
 *       (~2 ms apart) until it shows it. Lag = commit answered → visible on the replica. Prints a line per 10 s window.
 *   node scripts/e16-replica.ts stale [orders=100]
 *       Customers check out, then IMMEDIATELY open "My orders" through the shop: how often is the new order missing?
 *       Run with READ_YOUR_WRITES=off (the bug) and on (the fix). Uses loadtest+40..49 and the lab admin.
 *
 * Runs with plain node (type stripping), from apps/api. Reads .env at the repo root.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mysql from 'mysql2/promise';

const ROOT = resolve(import.meta.dirname, '../../..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = process.env.BASE_URL ?? 'http://localhost:8088';
const mode = process.argv[2];
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN;
};
const f = (x: number) => (Number.isNaN(x) ? '-' : x.toFixed(1));

async function lag(seconds: number) {
  const conn = (port: number) =>
    mysql.createConnection({ host: '127.0.0.1', port, user: 'scalecart', password: env.DB_PASSWORD, database: 'scalecart_orders' });
  const primary = await conn(Number(env.MYSQL_PORT ?? 3307));
  const replica = await conn(Number(env.MYSQL_REPLICA_PORT ?? 3308));
  const t0 = performance.now();
  let window: number[] = [];
  let missed = 0;
  const all: number[] = [];
  let windowStart = 0;
  console.log('| window (s) | markers | lag p50 / p95 / p99 / max ms | not seen within 10 s |');
  console.log('|---|---|---|---|');
  for (let n = 1; performance.now() - t0 < seconds * 1000; n++) {
    // The marker: a unique timestamp in the year 2000 (n microseconds after its start).
    const marker = new Date(Date.UTC(2000, 0, 1) + n).toISOString().replace('T', ' ').replace('Z', '');
    await primary.query(
      'INSERT INTO replication_heartbeat (id, beat_at) VALUES (2, ?) ON DUPLICATE KEY UPDATE beat_at = VALUES(beat_at)',
      [marker],
    );
    const committed = performance.now();
    let seen = false;
    while (!seen && performance.now() - committed < 10_000) {
      const [rows] = (await replica.query("SELECT DATE_FORMAT(beat_at, '%Y-%m-%d %H:%i:%s.%f') AS m FROM replication_heartbeat WHERE id = 2")) as unknown as [{ m: string }[]];
      // No sleep between polls: on Windows even sleep(2) takes ~14 ms (timer resolution), which inflated the first
      // trial's numbers. Back-to-back queries (~1.6 ms each) give ~2 ms resolution.
      seen = rows[0]?.m?.startsWith(marker.slice(0, 23)) ?? false;
    }
    if (seen) {
      const ms = performance.now() - committed;
      window.push(ms);
      all.push(ms);
    } else missed++;
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed - windowStart >= 10) {
      console.log(`| ${windowStart.toFixed(0)}–${elapsed.toFixed(0)} | ${window.length} | ${f(pct(window, 0.5))} / ${f(pct(window, 0.95))} / ${f(pct(window, 0.99))} / ${f(Math.max(...window))} | ${missed} |`);
      window = [];
      missed = 0;
      windowStart = elapsed;
    }
    const wait = 100 - (performance.now() - committed);
    if (wait > 0) await sleep(wait);
  }
  console.log(`\nall: ${all.length} markers, lag p50 ${f(pct(all, 0.5))} ms, p95 ${f(pct(all, 0.95))}, p99 ${f(pct(all, 0.99))}, max ${f(Math.max(...all))}`);
  await primary.end();
  await replica.end();
}

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = (await r.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error(`login ${email}: ${r.status}`);
  return body.accessToken;
}

async function stale(orders: number) {
  const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const admin = await login('e15-admin@scalecart.local', env.LAB_ADMIN_PASSWORD);
  const product = await fetch(`${BASE}/products`, {
    method: 'POST',
    headers: json(admin),
    body: JSON.stringify({ sku: `E16-${randomUUID().slice(0, 8)}`, name: 'E16 stale-read test item', priceCents: 100, description: 'E16' }),
  }).then((r) => r.json() as Promise<{ id: number }>);
  await fetch(`${BASE}/inventory/${product.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ available: orders + 10 }) });

  const users: string[] = [];
  for (let n = 40; users.length < 10 && n < 80; n++) {
    try {
      users.push(await login(`loadtest+${n}@scalecart.local`, env.SEED_USER_PASSWORD));
    } catch {
      /* 2FA user or rate-limited: skip */
    }
  }
  for (const token of users) await fetch(`${BASE}/cart`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });

  let missing = 0;
  let failed = 0;
  const readMs: number[] = [];
  for (let i = 0; i < orders; i++) {
    const token = users[i % users.length];
    // One checkout per user every 2 s at most (rate limit 5 burst, 0.5/s): 10 users → ~5/s.
    if (i >= users.length * 4) await sleep(200);
    const order = await fetch(`${BASE}/checkout`, {
      method: 'POST',
      headers: { ...json(token), 'idempotency-key': randomUUID() },
      body: JSON.stringify({ buyNow: { productId: product.id, quantity: 1 } }),
    });
    if (order.status !== 201) {
      failed++;
      continue;
    }
    const { id } = (await order.json()) as { id: string };
    const t = performance.now();
    const list = (await (await fetch(`${BASE}/orders?limit=5`, { headers: { authorization: `Bearer ${token}` } })).json()) as { items: { id: string }[] };
    readMs.push(performance.now() - t);
    if (!list.items.some((o) => o.id === id)) missing++;
  }
  const done = orders - failed;
  console.log(`orders placed: ${done} (${failed} checkouts failed)`);
  console.log(`"My orders" right after checkout MISSED the new order: ${missing} of ${done} (${((missing / done) * 100).toFixed(1)}%)`);
  console.log(`"My orders" answered in p50 ${f(pct(readMs, 0.5))} ms, p95 ${f(pct(readMs, 0.95))}, max ${f(Math.max(...readMs))}`);
}

if (mode === 'lag') await lag(Number(process.argv[3] ?? 60));
else if (mode === 'stale') await stale(Number(process.argv[3] ?? 100));
else {
  console.error('usage: node scripts/e16-replica.ts <lag [seconds]|stale [orders]>');
  process.exit(2);
}
