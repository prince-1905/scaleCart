# E15 — Product search in OpenSearch, kept in sync by events (CQRS)

**Date:** 2026-11-21 to 2026-11-23 · **Phase:** 12 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop. The charger kept reconnecting (Windows event 105); runs with such an event inside them are marked |
| Write side (truth) | MySQL `scalecart_catalog`, 200,103 products (seed). A product create/edit writes the row **and** a `product.changed` outbox row in one transaction |
| Read side (copy) | **OpenSearch 3.8.0**, one node, 512 MB heap, 1 CPU, security plugin off (Docker network only). Index behind the alias `products`: name (×3) + description as English text, category keyword, price integer, `listed` flag |
| Sync | Worker: outbox relay → RabbitMQ `search.product-changes` (quorum, retry, DLQ) → `ProductIndexer` reads the product **fresh from MySQL** and writes it to OpenSearch (or deletes it). Idempotent and safe against old or repeated events |
| Search query | `bool.should` of two `multi_match` (AND of all words): fuzzy full words + `bool_prefix` (the last word may be unfinished, also fuzzy). `fuzziness AUTO:3,8`, `prefix_length 1`, `max_expansions 20` (the tuning is part of E15b/c) |
| Fallback | Circuit breaker (5 failures → MySQL for 10 s, timeout 1 s; facets: own breaker, 3 s) → MySQL FULLTEXT. **Bulkhead:** at most 4 fallback searches at once, else a quick `503 search_busy`. Response header `X-Search-Source: opensearch \| mysql-fallback \| mysql` |
| Switch | `SEARCH_ENGINE=opensearch \| mysql` (MySQL FULLTEXT only, for comparisons) |
| Scope | Shoppers see only `listed` products. The experiments search **all 200k** (`scope=all`, lab-only), uncached |
| Raw data | `load-tests/results/e15-*` |

---

## E15a — Search quality: 20 fixed queries

`load-tests/e15-search-quality.mjs`: a query "finds" if a result's name contains the word the shopper meant.

| Kind | OpenSearch | MySQL FULLTEXT |
|---|---|---|
| Exact words ("black leather boot") | 4 of 4 | 4 of 4 |
| Plurals ("boots", "jackets") | **3 of 3** | 1 of 3 |
| Typo, 1 letter ("sneeker", "jaket", "sunglases") | **6 of 6** | **0 of 6** |
| Typo, 2 letters ("snekaer", "jackte", "parak") | **3 of 3** | **0 of 3** |
| Unfinished last word ("sne", "black jac", "woo swea") | 3 of 3 | 3 of 3 |
| Word order ("leather black boot") | 1 of 1 | 1 of 1 |
| **Total** | **20 of 20** | **9 of 20** |

- A typo on MySQL means **0 results**: the shopper sees an empty page. OpenSearch's English analyzer also folds
  plurals ("jackets" → jacket); MySQL's FULLTEXT doesn't.
- Ranking: "denim jacket" puts the product named *Everyday Denim Jacket* first on OpenSearch (name counts 3×).
- **Precision vs recall (found while tuning):** with plain `fuzziness: AUTO` (2 typos allowed from 6 letters),
  "sneaker" also matched "sweater" (2 letters apart): **16,005** matches instead of **8,004**. `AUTO:4,8` fixed that but
  broke "woo swea" (no typo allowed in 3 letters). `AUTO:3,8` (1 typo from 3 letters, 2 from 8) kept 20 of 20 and
  8,004. Trade-off: `prefix_length 1` means a typo in the **first** letter is not forgiven.
- First query of each run is slow on both (cold): 371–378 ms; the rest 5–46 ms.

## E15b — Search under load: MySQL FULLTEXT vs OpenSearch

`load-tests/e15-search-load.js` (k6, 60 s, open model): RATE searches/s over all 200k (1–3 real catalog words) +
a **probe** of 20 `GET /cart`/s (a MySQL read in another database on the same server: "does search load hurt the
rest of the shop?"). CPU from `docker stats` (100% = one core). 50 logged-in users.

### Before the fixes (2 rounds)

| Engine · rate | Search p50 / p95 ms | Search errors | Fallbacks | Probe `/cart` p95 ms | CPU avg: MySQL · OpenSearch · shop |
|---|---|---|---|---|---|
| MySQL · 50/s | 25–30 / 121–602 | 0 | – | 18–53 | **100–124%** · ~1% · 28–31% |
| MySQL · 200/s | 10 s (timeouts) | **8,993–9,036** | – | 579–691 | 192–194% · ~3% · 73–74% |
| OpenSearch · 50/s | 11–15 / 109–1,035 | 0 | 681 / 1 | 33–42 | 45% / 6% · 36–48% · 32–36% |
| OpenSearch · 200/s | 9.7–10 s | **5,133–7,707** | 1,086–1,143 | 630–867 | **165–185%** · 30–50% · 73% |

- MySQL FULLTEXT over 200k rows is CPU-heavy: 50 searches/s already used **more than one MySQL core**; 200/s timed out
  almost everything and slowed the cart (p95 ~0.6–0.7 s vs ~20–50 ms).
- **OpenSearch at 200/s collapsed too, and took MySQL with it (cascading failure).** OpenSearch's one core was full
  (the fuzzy query expanded every word into up to 50 similar terms), searches timed out after 1 s, the breaker sent
  them to MySQL, and MySQL (the slower engine!) hit 165–185% CPU. The backup made the overload worse.

### The fixes

1. **Cheaper typo matching:** `prefix_length 1` (first letter must be right) + `max_expansions 20`.
2. **Bulkhead on the fallback:** at most 4 MySQL fallback searches at once; more → quick `503 search_busy`. Losing
   some searches is better than losing checkout.

### After the fixes (same script)

| Run | Search p50 / p95 / p99 ms | Search errors | Fallbacks | Probe `/cart` p95 ms | CPU avg: MySQL · OpenSearch · shop |
|---|---|---|---|---|---|
| OpenSearch · 50/s, round 1 | **9.5** / 42 / 202 | 0 | 0 | 20 | **4.6%** · 25% · 28% |
| OpenSearch · 50/s, round 2 | **8.8** / 22 / 56 | 0 | 0 | 16 | **4.4%** · 21% · 25% |
| OpenSearch · 200/s, round 1 | 121 / 1,080 / 1,478 | **2,746** (of 13,062) | 694 | 541 | 55% · 67% · 77% |
| OpenSearch · 200/s, round 2 (power event inside) | **12.6** / 439 / 627 | **0** | 0 | 160 | **4.9%** · 75% · 64% |

- **50/s:** p50 ~9 ms, MySQL CPU **~4.5% instead of 100–124%**: search load is off the database checkout needs.
- The two 200/s runs disagreed (2,746 errors vs 0), so I ran more.

### 200/s, more runs: a bug in the circuit breaker

Two more 200/s runs with the final query (`AUTO:3,8`) were **worse**: 7,873 and 6,891 search errors, MySQL at
**143–149%**, while OpenSearch averaged only 38–44%. The shop's log said `circuit breaker … is now open` **2,362
times**. The cause was a bug in my `CircuitBreaker`:

- Hundreds of searches are in flight when it opens. Each one that timed out **late** counted as a new failure,
  re-opened the breaker and restarted its 10 s open period. Any late result (an old success, too) also freed the
  half-open "one trial at a time" slot.
- **Fix** (`common/circuit-breaker.ts`, same file in payments): a *generation* number, +1 each time it opens; a call
  only counts if the breaker hasn't opened since the call started, and only the trial call frees the trial slot.
  Two new tests; both fail on the old code. After the fix: 5 opens in a whole run instead of 2,362.

All 200/s runs with the fixed breaker (runs 3–6: shop container recreated just before each, i.e. started cold;
bulkhead 4, 1, 4, 1):

| Run | Search p50 / p95 ms | Search errors | Fallbacks | Probe `/cart` p95 ms | CPU avg: MySQL · OpenSearch · shop |
|---|---|---|---|---|---|
| 1 | 26 / 983 | 7,566 | 3,289 | 332 | 163% · 33% · 73% |
| 2 | 16 / 388 | **0** | 0 | 105 | 4.8% · 76% · 65% |
| 3 | 11 / 332 | 1,386 | 703 | 189 | 36% · 51% · 66% |
| 4 | 9.7 / 296 | **0** | 0 | 234 | 5.5% · 57% · 67% |
| 5 | 11 / 368 | **0** | 0 | 297 | 5.1% · 57% · 72% |
| 6 | 8.8 / 287 | **0** | 0 | 219 | 4.9% · 54% · 66% |

- **200/s is the edge for OpenSearch on 1 CPU:** 4 of 6 runs clean (p50 9–16 ms, p95 0.3–0.4 s), 2 tipped over.
  The CPU timeline of the bad run shows a cycle: breaker closes → OpenSearch at 100% of its core within 2–4 s →
  timeouts → breaker opens for 10 s, OpenSearch idle (1–5%), MySQL busy with fallbacks → closes again.
- The bulkhead limit of 4 let MySQL reach ~200% (its whole 2-CPU limit) in those cycles: too generous for "protect
  MySQL" (see E15e+ below for what actually hurt the cart).
- The fix for real traffic is capacity (more OpenSearch CPU or nodes) or caching popular searches; not built.

## E15c — Facets: counts per category and price range

`load-tests/e15-facets.mjs`: `GET /products/search/facets` over all 200k, 30 sequential requests per query after 3
warm-ups. OpenSearch: one query with a `terms` + `range` aggregation. MySQL: a GROUP BY category + a SUM per price range.

| Query (matches) | OpenSearch p50 ms (2 runs) | MySQL p50 ms |
|---|---|---|
| sneaker (8,004) | 14.2–18.0 | 45.8 |
| black (13,333) | 12.7–16.1 | 71.6 |
| leather boot (665) | 13.5–15.2 | 32.2 |
| blue wool sweater (99) | 16.7–17.9 | 35.9 |
| everything (200,103) | 12.5–14.5 | 55.9 |

- OpenSearch p50 **12–18 ms** for every query; MySQL **32–72 ms**, growing with the number of matches.
- OpenSearch's tail was spiky: p95 up to 1.1 s, max 1.5 s (a few requests per run).
- **Found a bug on the way:** the first OpenSearch run was answered by `mysql-fallback`. Facets shared the search
  breaker and its 1 s timeout; a few slow aggregations tripped it, and **plain searches** went to MySQL as well. Fix:
  facets have their own breaker and a 3 s timeout. (That run's numbers are not in the table.)

## E15e — OpenSearch stopped for 30 s, under 50 searches/s

`load-tests/e15-search-ops.mjs down`: 50 searches/s from 10 users; `docker compose stop opensearch`, 30 s, `start`.

| Phase | Run 1 (power event during "starting") | Run 2 (power event during "stopped") |
|---|---|---|
| Before | 501 of 501 ok (OpenSearch), p50 8.8 ms | 501 of 501 ok, p50 10.2 ms |
| Stopped (31.5 s) | **1,566 of 1,576 ok** (1,534 by MySQL), 10 × 503 | **1,536 of 1,581 ok** (1,501 by MySQL), 45 × 503 |
| Starting until it answers again | 3,097 of 3,109 ok, 12 × 503 | 3,087 of 3,103 ok, 16 × 503 |
| After (10 s) | 500 of 500 ok: 335 OpenSearch, 165 MySQL, p50 134 ms | 500 of 500 ok: 339 / 161, p50 54 ms |

- **No 500s, no timeouts.** 97–99% of searches were answered while OpenSearch was gone; the rest got a quick 503
  from the bulkhead. p50 17–20 ms on MySQL at this rate.
- OpenSearch needed **52 s** after the start command to answer again (JVM boot + opening the index), both runs.
- Right after it came back it was still slow (cold caches): some searches timed out, the breaker opened again, and a
  third of the "after" searches still came from MySQL.

### E15e+ — OpenSearch stopped at 200 searches/s: the cart broke, and MySQL wasn't the reason

To compare bulkhead sizes, every search had to use the fallback: OpenSearch stopped, k6 at 200 searches/s + 20
`/cart`/s, `SEARCH_FALLBACK_CONCURRENCY` 4 vs 1, 2 runs each.

| Bulkhead | Searches answered (MySQL) | Probe `/cart` failed | `/cart` p99 ms | MySQL CPU avg |
|---|---|---|---|---|
| 4 (run 1 / 2) | 2,621 / 1,378 | **29 / 38** | 4,941 / 6,381 | 69% / 53% |
| 1 (run 1 / 2) | 1,746 / 2,349 | **30 / 31** | 4,803 / 4,850 | 67% / 79% |

- The bulkhead size made **no clear difference**, and MySQL was far from full. Yet ~30 cart requests per run failed
  (Kong: 500 from the shop). A rerun with the logs kept showed why: **`connect ETIMEDOUT` from the MySQL driver**,
  59 times.
- **Cause:** with OpenSearch's container stopped, looking up the name `opensearch` takes **4 s** inside Docker
  (measured in the shop container: `opensearch` ENOTFOUND after 4,003–4,007 ms; `mysql` 0–3 ms). Node does name
  lookups on its thread pool (4 threads). The ~200 searches of the first second each started a lookup and held a
  thread for 4 s; the cart's new MySQL connections needed a lookup too, queued behind them and timed out.
- **Fix** (`common/shared-lookup.ts`, used by the OpenSearch client's agent): concurrent lookups of the same name
  share one real lookup; the answer is kept 5 s (a failure 2 s). One dead name now costs one thread. 2 unit tests
  (one fails without the sharing).
- **After the fix, same test, 2 runs: 0 cart failures, 0 `ETIMEDOUT`.** Cart p95 4.3 s in run 1 (the laptop was at
  90% CPU, the shop's event loop at 100%), 363 ms in run 2. Both runs had host CPU above 85%: treat the latencies as
  rough; the 0 failures is the result.

## E15f — Rebuilding the whole index under 50 searches/s

`load-tests/e15-search-ops.mjs reindex` runs `docker compose run --rm migrate node dist/reindex.js`: a NEW index
(`products_<time>`, refresh off), 200,103 products copied in keyset batches of 2,000, refresh on, **one atomic alias
switch**, then a catch-up of products changed since the copy began, then the old index is deleted.

| | Run 1 (power events 3 s before and 8 s after) | Run 2 |
|---|---|---|
| Copy of 200,103 products | 37.1 s | **8.7 s** |
| Searches during the rebuild | 1,978 of 2,052 ok (74 × 503; 6 by MySQL) | **565 of 565 ok**, p95 79 ms |
| After the switch | 500 of 500, p50 8.9 ms | 501 of 501, p50 8.4 ms |

- **The alias switch itself caused no errors**, in both runs. Searchers never see a half-built index.
- Run 1 was slow and cold (4× longer); building the copy competed with live searches on OpenSearch's one CPU, a few
  searches timed out and the bulkhead turned the overflow into 503s. Run 2 had 0 errors.
- **Found a measuring bug here:** the first version of this script ran docker with a blocking `execSync`, which froze
  the load generator for the whole rebuild and then fired every missed request at once. Fixed (async `exec`), and the
  runs above use the fixed script. The same bug had distorted the operations phases of E12 and E14 (corrected there).

## E15d — Freshness: an admin edit → visible in search

`load-tests/e15-freshness.mjs` (lab admin `e15-admin@scalecart.local`, created for this with the owner's OK; the
seed admin has 2FA). Renames a random product to include a new random word (`zq` + 8 letters), then asks search
for that word every 60 ms. Clock starts when the PATCH answers (committed). Names are put back afterwards.

| | Run 1 | Run 2 |
|---|---|---|
| 20 edits, one at a time: visible after p50 / p95 | **840 / 1,449 ms** | **806 / 1,240 ms** |
| min / max | 170 / 2,426 ms | 306 / 1,369 ms |
| Found | 20 of 20 | 20 of 20 |

| | Burst 1 | Burst 2 |
|---|---|---|
| 50 edits at once: all committed after | 3.4 s | **19.8 s** |
| All 50 visible in search, after the last commit | 847 ms | 565 ms |

- **About 0.8 s typical, under 1.5 s at p95.** The parts: outbox relay poll (every 200 ms) + RabbitMQ + indexer
  (~80 ms in a trace) + OpenSearch's refresh (every 1 s: a new document becomes searchable at the next refresh).
- The burst found a different problem: **committing 50 edits at once was slow**. One traced PATCH took 10.3 s: 3.3 s
  before the shop started on it, `UPDATE products` 1.8 s, the outbox `INSERT` 4.3 s, commit 0.26 s. Then relay +
  indexer took ~0.4 s. The catalog's writes queue up (connection pool + outbox locks, not pinned down). It's an admin
  path; noted, not fixed.
- A first run 2 stopped halfway: right after OpenSearch's restart, a facet count timed out and was answered by the
  MySQL fallback (13.7 s, traced). Rerun when warm. Its leftover test names were found in MySQL and renamed back
  through the API (0 left).

---

## E15g — Found on the way: Kong kept old container addresses

While rerunning, logins started going to the **shop's** port and searches to an address nobody had (502). My runner
had recreated the shop and identity; Docker gave them each other's IPs, and Kong kept the old answers: Docker's DNS
gives a 600 s TTL and Kong had no `dns_valid_ttl` (its compose comment said "re-ask often", but only the stale and
not-found TTLs were set). `load-tests/e15-kong-dns.mjs`: recreate both, probe each through NGINX → Kong every 250 ms for 60 s
(`load-tests/results/e15-kong-dns.txt`).

| | IPs swapped? | Shop failing until | Identity failing until |
|---|---|---|---|
| Before (no `KONG_DNS_VALID_TTL`) | yes | **still failing at 60 s** (65 failed probes) | **still failing at 60 s** |
| After `KONG_DNS_VALID_TTL=5`, run 1 | no | 19.8 s | 16.6 s |
| After, run 2 | no | 22.0 s | 17.9 s |
| After, run 3 | yes | **37.0 s** | **35.4 s** |

- Recreating a container behind Kong could leave it unreachable for minutes; now it's ~17–37 s, most of which is the
  containers booting (the recreate itself takes 7.5–9.6 s). Earlier E12/E14 operations restarted containers in place
  (same IP), so they didn't hit this.

---

## Tests

Passing on 2026-11-23: shop **77 unit** (69 + 6 circuit breaker + 2 shared lookup), **147 end-to-end** (140 + 7
search tests against a real OpenSearch, index `test-products`); payments 18 unit (+2 breaker). The first full e2e
run after the fixes had 4 failing files (two suites failed at setup, one health and one rate-limit timing test);
those files passed alone (22 of 22) and the next full run passed 147 of 147: flaky under load, not investigated
further. Identity is unchanged in this phase.
- New e2e: a new product becomes searchable through outbox → RabbitMQ → indexer, with a typo in the last word and an
  unfinished word; an edit reaches the copy; shoppers only see listed products and `scope=all` is lab-only (400);
  facets; the indexer is idempotent and removes a vanished product; OpenSearch unreachable → answered by MySQL
  (`mysql-fallback`); `SEARCH_ENGINE=mysql`.
- Mutation-checked (each broke exactly one test): no fuzzy full-word query (the typo test failed); edits write no
  outbox event (the edit test); no MySQL fallback (the fallback test); the indexer never removes vanished products
  (the idempotency test). Also the 2 new breaker tests and the shared-lookup test fail on the broken versions.
- Not covered by an automated test: the bulkhead, the separate facets breaker, Kong's DNS setting (all measured above).
