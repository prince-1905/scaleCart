/**
 * E1 — Search and pagination, measured inside MySQL (no HTTP, no Node framework),
 * so the only thing that differs between rows is the query itself.
 *
 *   cd apps/api && node scripts/e1-queries.ts
 *
 * Needs the Compose MySQL with `SEED_PRODUCTS=200000` seeded. Connects as root only
 * to read performance_schema (rows examined per statement). Lab tool, not app code.
 */
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const DOT_ENV = new URL('../../../.env', import.meta.url);
if (existsSync(DOT_ENV)) process.loadEnvFile(DOT_ENV);
if (!process.env.MYSQL_ROOT_PASSWORD) throw new Error('Set MYSQL_ROOT_PASSWORD in the repo-root .env');

const RUNS = Number(process.env.RUNS ?? 30);
const conn = await createConnection({
  host: '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3307),
  user: 'root',
  password: process.env.MYSQL_ROOT_PASSWORD,
  database: 'scalecart_catalog',
});

const COLUMNS = 'id, sku, name, description, price_cents';

interface Case {
  group: string;
  label: string;
  sql: string;
  params: unknown[];
}

/** Rows MySQL examined for the last statement on this connection (performance_schema). */
async function rowsExamined(): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ROWS_EXAMINED AS n FROM performance_schema.events_statements_history
      WHERE THREAD_ID = PS_CURRENT_THREAD_ID() AND SQL_TEXT NOT LIKE '%performance_schema%'
      ORDER BY EVENT_ID DESC LIMIT 1`,
  );
  return Number(rows[0]?.n ?? NaN);
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function measure(c: Case) {
  for (let i = 0; i < 3; i++) await conn.query(c.sql, c.params); // warm the buffer pool
  const [result] = await conn.query<RowDataPacket[]>(c.sql, c.params);
  const examined = await rowsExamined();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await conn.query(c.sql, c.params);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { returned: result.length, examined, p50: percentile(times, 50), p95: percentile(times, 95) };
}

async function count(where: string, params: unknown[]) {
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM products WHERE ${where}`, params);
  return Number(rows[0].n);
}

const [[{ total }]] = await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM products');

// ---- search: LIKE '%word%' vs FULLTEXT, same words, both look at name + description ----
const SEARCHES = [
  { label: 'common word "leather"', words: ['leather'] },
  { label: 'three words "red leather boot"', words: ['red', 'leather', 'boot'] },
  { label: 'no match "unicorn"', words: ['unicorn'] },
];
const cases: Case[] = [];
const matches: Record<string, number> = {};
for (const s of SEARCHES) {
  const likeWhere = s.words.map(() => "CONCAT(name, ' ', description) LIKE ?").join(' AND ');
  const likeParams = s.words.map((w) => `%${w}%`);
  const ftQuery = s.words.map((w) => `+${w}*`).join(' ');
  matches[s.label] = await count(likeWhere, likeParams);
  cases.push(
    { group: 'search', label: `${s.label} - LIKE`, sql: `SELECT ${COLUMNS} FROM products WHERE ${likeWhere} ORDER BY id LIMIT 20`, params: likeParams },
    { group: 'search', label: `${s.label} - FULLTEXT`, sql: `SELECT ${COLUMNS} FROM products WHERE MATCH (name, description) AGAINST (? IN BOOLEAN MODE) ORDER BY id LIMIT 20`, params: [ftQuery] },
  );
}

// ---- pagination: OFFSET vs keyset at increasing depth ----
for (const offset of [0, 10_000, 100_000, 199_980]) {
  const [[row]] = await conn.query<RowDataPacket[]>('SELECT id FROM products ORDER BY id LIMIT 1 OFFSET ?', [Math.max(0, offset - 1)]);
  const after = offset === 0 ? 0 : Number(row.id);
  cases.push(
    { group: 'pagination', label: `page at row ${offset.toLocaleString('en-US')} - OFFSET`, sql: `SELECT ${COLUMNS} FROM products ORDER BY id LIMIT 20 OFFSET ?`, params: [offset] },
    { group: 'pagination', label: `page at row ${offset.toLocaleString('en-US')} - keyset`, sql: `SELECT ${COLUMNS} FROM products WHERE id > ? ORDER BY id LIMIT 20`, params: [after] },
  );
}

const [[{ version }]] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS version');
console.log(`MySQL ${version}, ${Number(total).toLocaleString('en-US')} products, ${RUNS} timed runs per query (after 3 warm-up runs)\n`);
for (const [label, n] of Object.entries(matches)) console.log(`matching rows, ${label}: ${n.toLocaleString('en-US')}`);
console.log('\n| query | rows returned | rows examined | p50 ms | p95 ms |');
console.log('|---|---|---|---|---|');
for (const c of cases) {
  const r = await measure(c);
  console.log(`| ${c.label} | ${r.returned} | ${r.examined.toLocaleString('en-US')} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} |`);
}
await conn.end();
