/**
 * E15c — facet counts (per category, per price range) for a search over all 200k products: time per request,
 * sequential, after a warm-up. Run once per SEARCH_ENGINE.
 *
 *   node load-tests/e15-facets.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:8088';
const QUERIES = ['sneaker', 'black', 'leather boot', 'blue wool sweater', ''];
const N = 30;
/** ~15 requests/s: under the per-IP rate limit (20/s) for logged-out callers. */
const GAP_MS = 65;

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
let source = '';
console.log('| query | matches | p50 ms | p95 ms | max ms |');
console.log('|---|---|---|---|---|');
for (const q of QUERIES) {
  const url = `${BASE}/products/search/facets?scope=all${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  for (let i = 0; i < 3; i++) {
    await fetch(url).then((r) => r.text()); // warm-up
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const times = [];
  let total = 0;
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const body = await (await fetch(url)).json();
    times.push(performance.now() - t);
    if (body.total === undefined) throw new Error(`no facets: ${JSON.stringify(body).slice(0, 120)}`);
    total = body.total;
    await new Promise((r) => setTimeout(r, GAP_MS));
    source = body.source;
  }
  console.log(`| ${q || '(everything)'} | ${total.toLocaleString('en-US')} | ${pct(times, 50).toFixed(1)} | ${pct(times, 95).toFixed(1)} | ${Math.max(...times).toFixed(1)} |`);
}
console.log(`engine: ${source}`);
