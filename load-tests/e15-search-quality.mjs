/**
 * E15a — search quality: the same fixed queries against the running shop, scope=all (200k products). Run it once
 * with SEARCH_ENGINE=opensearch and once with SEARCH_ENGINE=mysql (recreate the api container in between).
 *
 *   node load-tests/e15-search-quality.mjs
 *
 * A query "finds" when it returns at least one product whose name contains the word the shopper meant.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:8088';

/** [what the shopper typed, the word they meant, kind] */
const QUERIES = [
  ['sneaker', 'sneaker', 'exact'],
  ['black leather boot', 'boot', 'exact'],
  ['wool sweater', 'sweater', 'exact'],
  ['denim jacket', 'jacket', 'exact'],
  ['sneakers', 'sneaker', 'plural'],
  ['boots', 'boot', 'plural'],
  ['jackets', 'jacket', 'plural'],
  ['sneeker', 'sneaker', 'typo (1 letter)'],
  ['jaket', 'jacket', 'typo (1 letter)'],
  ['sweter', 'sweater', 'typo (1 letter)'],
  ['backpak', 'backpack', 'typo (1 letter)'],
  ['black lether', 'leather', 'typo (1 letter)'],
  ['sunglases', 'sunglasses', 'typo (1 letter)'],
  ['snekaer', 'sneaker', 'typo (2 letters)'],
  ['jackte', 'jacket', 'typo (2 letters)'],
  ['parak', 'parka', 'typo (2 letters)'],
  ['sne', 'sneaker', 'unfinished word'],
  ['black jac', 'jacket', 'unfinished word'],
  ['woo swea', 'sweater', 'unfinished word'],
  ['leather black boot', 'boot', 'word order'],
];

let found = 0;
const byKind = {};
const rows = [];
let source = '';
for (const [q, meant, kind] of QUERIES) {
  const t = performance.now();
  const res = await fetch(`${BASE}/products/search?q=${encodeURIComponent(q)}&scope=all&limit=3`);
  const ms = performance.now() - t;
  source = res.headers.get('x-search-source') ?? source;
  const hits = await res.json();
  const ok = Array.isArray(hits) && hits.some((p) => p.name.toLowerCase().includes(meant));
  found += ok ? 1 : 0;
  byKind[kind] = byKind[kind] ?? { found: 0, of: 0 };
  byKind[kind].of++;
  byKind[kind].found += ok ? 1 : 0;
  rows.push(`| ${q} | ${kind} | ${ok ? 'yes' : '**no**'} | ${hits.slice(0, 3).map((p) => p.name).join(' · ') || '–'} | ${ms.toFixed(0)} |`);
}
console.log(`engine: ${source}`);
console.log('| typed | kind | found? | top 3 | ms |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(r);
console.log(`\nfound ${found} of ${QUERIES.length}: ${Object.entries(byKind).map(([k, v]) => `${k} ${v.found}/${v.of}`).join(', ')}`);
