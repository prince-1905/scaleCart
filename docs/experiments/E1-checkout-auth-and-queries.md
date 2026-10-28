# E1 — Overselling, idempotency, login cost, and query patterns

**Date:** 2026-10-27 · **Phase:** 1 · **Status:** done

## Setup (applies to every run below)

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H (6P + 4E cores, 16 threads), 15.7 GB RAM, Windows 11 |
| Docker | Docker Desktop 28.3.2 (WSL2 VM: 16 vCPUs, ~7.6 GB) |
| API | 1 × `api` container: NestJS 12.3 + **Fastify**, Node 24.22.1, TypeORM 1.1.2, mysql2 3.24.6, **CPU limit 1.0, 512 MiB**, access logs off, 5 DB connections per module pool |
| Database | MySQL **8.4.13**, one container, CPU limit 2.0, 1 GiB, `innodb_buffer_pool_size=512M`; 5 module databases on one server |
| Data | 200,018 products (seeded), 2,000 load-test users + admin |
| Path | k6 v2.2.0 (native Windows) → `localhost:8088` → NGINX 1.30 → `api:3000` → `mysql:3306` |
| Raw data | `load-tests/results/<run-id>.*` (not committed); run ids listed per experiment |

**Limitations:** laptop with hybrid cores, so absolute latencies vary between runs (see E1a, where identical
runs differed by up to 4×). k6, NGINX, the app and MySQL share one machine. Correctness results
(orders vs. stock) don't depend on the machine; latency results describe *this* laptop.

---

## E1a — Flash sale: can checkout oversell?

**Question:** 1,000 customers press "buy" at the same moment for a product with **100** units. How many
orders get created?

**Method:** `load-tests/e1-flash-sale.js`. Each run creates a fresh product with stock 100. 1,000 different
users each have 1 unit in their cart. Each virtual user opens its connection early (staggered over 5 s),
then all 1,000 send `POST /checkout` at the same timestamp. The API was restarted with each
`STOCK_RESERVATION` strategy. Three runs per strategy. Counts were checked **in MySQL**, not just in k6:

```sql
SELECT COUNT(*) AS orders, SUM(quantity) AS units_sold FROM scalecart_orders.order_items WHERE product_id = ?;
```

| Strategy | How stock is taken | Orders created (3 runs) | Stock left | Oversold |
|---|---|---|---|---|
| **naive** | `SELECT available` → check in Node → `UPDATE SET available = <computed>` | **474, 494, 499** | 0 | **374–399 units (4.7–5.0× the stock)** |
| **locking** | `SELECT … FOR UPDATE` → check in Node → `UPDATE` | 100, 100, 100 | 0 | 0 |
| **atomic** | `UPDATE … SET available = available - 1 WHERE product_id = ? AND available >= 1` | 100, 100, 100 | 0 | 0 |

Runs: naive `e1-flash-naive-20261027-200547`, `-200711`, `-200816`; locking `e1-flash-locking-20261027-200214`,
`-200327`, `-200431`; atomic `e1-flash-atomic-20261027-195842`, `-200000`, `-200102`.
Every non-naive run: exactly 100 × HTTP 201 and 900 × HTTP 409 `out_of_stock`, 0 other responses.

**The scary detail:** with the naive strategy, stock still shows **0** at the end. The counter looks
perfectly healthy while ~5× the stock was sold. Many buyers read "57", each wrote "56": **lost updates**.
Only counting the orders reveals the bug.

**Latency (checkout, all 1,000 requests in the burst):**

| Strategy | p50 ms (run 1 / 2 / 3) | p99 ms (run 1 / 2 / 3) |
|---|---|---|
| atomic | 9,163 / 2,604 / 2,396 | 12,465 / 3,173 / 2,906 |
| locking | 7,539 / 2,234 / 2,435 | 9,899 / 2,711 / 2,877 |
| naive | 3,200 / 3,099 / 6,820 | 4,092 / 3,653 / 7,578 |

- **No conclusion about atomic vs. locking speed from this data.** Identical runs varied up to 4× (the
  first run after each restart was slowest). The difference between strategies is smaller than the noise.
  With one hot row and a pool of only 5 inventory connections, both strategies wait in the same queue.
- 1,000 checkouts at once took ~2.5–3 s to drain on 1 API CPU (when the run wasn't a slow outlier).
  Each buyer waits seconds: a real drop needs a queue or "waiting room" in front (later phase).

### Test-rig finding: 1,000 *new* connections at once

The first version opened each buyer's TCP connection at the moment of the sale. In
`e1-flash-atomic-20261027-195301` **362 of 1,000** requests failed: k6 error 1212, *connection refused*.
They never reached NGINX or the app (neither logged anything). Docker Desktop's port forwarder on
Windows couldn't accept 1,000 new connections in the same instant. The script now opens connections before
the sale, like shoppers who already have the page open. That run's order count was still exactly 100.

## E1b — Double-click: one order per checkout attempt?

**Question:** if every buyer sends the same checkout twice at the same moment (same `Idempotency-Key`),
does anyone get two orders?

**Method:** same script, `PART=double-click`, stock = 2 × buyers (so stock never runs out), atomic strategy.
Checked in MySQL: orders per buyer for that product.

| Run | Buyers / requests | Orders | Buyers with an order | Max orders per buyer | Replayed (201) | "In progress" (409) | 504 |
|---|---|---|---|---|---|---|---|
| `e1-flash-double-click-20261027-201147` | 500 / 1,000 | **495** | 495 | **1** | 71 | 418 | 16 |
| `e1-flash-double-click-20261027-201003` | 1,000 / 2,000 | **869** | 869 | **1** | 167 | 449 | 515 |

- **Zero duplicate orders** in both runs. The second request of each pair either got the stored answer
  (`Idempotent-Replayed: true`) or a 409 "still being processed, retry".
- **504s = a new bottleneck, not an idempotency failure.** NGINX logged
  `upstream timed out (110) while connecting to upstream`: under a 2,000-request burst it couldn't open new
  connections to Node within its 2 s `proxy_connect_timeout`. Those requests never reached the app, so no
  order and no stock change. A client retry with the same key would be safe. Most likely cause: Node's accept
  queue (default backlog 511) overflowing. **Not yet verified.** Follow-up in Phase 2 (load balancing).

## E1c — Catalog read baseline (one row from MySQL)

**Method:** `GET /products/:id` for random ids among 200k, stepped open-model rates.
Run `e1-catalog-20261027-201244`.

| Target rps | Achieved | p50 ms | p95 ms | p99 ms | Errors | Dropped |
|---|---|---|---|---|---|---|
| 250 | 250 | 2.2 | 13.7 | 71.8 | 0% | 0 |
| 500 | 500 | 1.2 | 15.7 | 66.6 | 0% | 0 |
| 1,000 | 981 | 4.5 | 173.3 | 320.7 | 0% | 381 |
| 1,500 | 1,184* | 1,313 | 1,880 | 2,399 | 0% | 6,324 |
| 2,000 | 1,246* | 1,448 | 2,071 | 2,233 | 0% | 15,091 |

\* overstated for overloaded steps (see the E0 note). **Peak server throughput: ~1,360 req/s**
(`rate(http_server_request_duration_seconds_count{route="/products/:id"}[20s])`). Event-loop
utilization reached **1.0**, so the API process (framework + driver + TypeORM) was the limit at 1 CPU.
Compare E0: `/lab/ping` ≈ 4,300 req/s. Adding one indexed DB read cut throughput about 3×.
**This is the "before" number for Phase 2's Redis cache.**

## E1d — What does a login cost?

**Method:** `POST /auth/login` (Argon2id: 19 MiB, 2 passes, 1 lane = OWASP minimum), random users,
stepped rates. Run `e1-login-20261027-201515`.

| Target logins/s | Achieved | p50 ms | p95 ms | p99 ms | Dropped |
|---|---|---|---|---|---|
| 5 | 5 | 34.9 | 81.7 | 105.4 | 0 |
| 10 | 10 | 30.3 | 54.9 | 92.3 | 0 |
| 20 | 20 | 32.6 | 387.8 | 447.6 | 0 |
| 30 | 26* | 3,304 | 6,203 | 6,596 | 75 |
| 40 | 29* | 8,615 | 13,331 | 13,751 | 215 |
| 60 | 36* | 16,825 | 23,437 | 24,419 | 485 |

- **Peak server throughput: ~22 logins/s** (20 s window). That is **~60× fewer** than catalog reads on
  the same CPU.
- One password check took **29.5 ms** on average at 10 logins/s (`password_hash_duration_seconds`).
  Theory: 1 CPU / 29.5 ms ≈ 34/s. We got ~22: JWT signing, a refresh-token INSERT, HTTP, and a CPU
  *limit* that isn't a dedicated core (same effect as E0).
- Event-loop utilization peaked at only **0.41**: the hashing ran on libuv's thread pool, not on the event loop.

## E1e — Does login traffic hurt other endpoints? (head-of-line, part 2)

**Method:** catalog reads at 500 req/s (comfortably below their limit) for 20 s alone, then 20 s with
10 logins/s (~half the login capacity) on the same API process. Two runs.
Throttled time = `increase(container_cpu_throttled_seconds_total)` over each ~18 s window.

| Run | Scenario | p50 ms | p95 ms | p99 ms | CPU throttled |
|---|---|---|---|---|---|
| `e1-hol-20261027-201834` | catalog alone | 2.1 | 55.5 | **113.0** | 1.04 s |
| | catalog + logins | 2.3 | 522.8 | **948.9** | 10.67 s |
| `e1-hol-20261027-201942` | catalog alone | 1.8 | 27.4 | **74.7** | 2.10 s |
| | catalog + logins | 25.0 | 700.7 | **822.7** | 11.61 s |

- Catalog **p99 got 8–11× worse**, with the event loop never saturated (ELU max ~0.7).
- **Why:** Argon2 runs on thread-pool threads, but they share the container's **1-CPU quota** with the
  event loop. When the hashing threads use up the quota, the kernel pauses the *whole container*, event loop
  included, until the next 100 ms period. Throttled time went up ~5–10×.
- **"Off the event loop" ≠ "free".** It only moves the work to another thread *inside the same CPU budget*.
  Fixes: give auth its own pods (isolation), rate-limit logins, more CPU per pod, and keep sessions long
  (refresh tokens) so users rarely need a full password login.

## E1f — Search and pagination inside MySQL

**Method:** `apps/api/scripts/e1-queries.ts`. Queries sent directly to MySQL (no HTTP), 3 warm-up runs then
30 timed runs each. "Rows examined" from `performance_schema.events_statements_history`.
All queries `ORDER BY id LIMIT 20`, searching name + description.
Raw: `load-tests/results/e1-queries-20261027-202052.md`.

### LIKE '%word%' vs. FULLTEXT

| Search | Matching rows | Method | Rows examined | p50 ms | p95 ms |
|---|---|---|---|---|---|
| common word "leather" | 16,665 | LIKE | 162 | **1.77** | 2.83 |
| | | FULLTEXT | 16,685 | 48.53 | 67.46 |
| three words "red leather boot" | 99 | LIKE | 35,930 | 37.28 | 44.91 |
| | | FULLTEXT | 119 | **15.03** | 25.26 |
| no match "unicorn" | 0 | LIKE | **200,018** | 186.72 | 218.80 |
| | | FULLTEXT | 0 | **0.93** | 1.09 |

- **FULLTEXT isn't always faster.** For a very common word, LIKE walks the primary key in id order and
  stops after 20 hits (162 rows read). FULLTEXT first collects *all* 16,665 matches, then sorts them.
- **LIKE's worst case is terrible:** no match = full table scan, 200k rows, 187 ms, growing with the table.
  Typos and nonsense searches are common, and they are free for an attacker to send.
- FULLTEXT's cost grows with the number of *matches*, not table size: **0.9 ms** for no match, 15 ms for a
  specific phrase. Worst case here: 48 ms (common word).
- The API uses FULLTEXT: predictable worst case beats a great best case. Better ranking, typo tolerance and
  facets need a search engine (OpenSearch), a later-phase topic.

### OFFSET vs. keyset pagination

| Page starting at row | OFFSET: rows examined | OFFSET p50 ms | Keyset: rows examined | Keyset p50 ms |
|---|---|---|---|---|
| 0 | 20 | 0.95 | 20 | 0.96 |
| 10,000 | 10,020 | 4.77 | 20 | 1.02 |
| 100,000 | 100,020 | 39.32 | 20 | 0.94 |
| 199,980 | 200,000 | **70.48** | 20 | **1.24** |

- OFFSET reads and throws away every row before the page: cost grows linearly with depth (**57× slower**
  at the last page).
- Keyset (`WHERE id > :lastSeenId`) jumps straight there through the index: **20 rows, ~1 ms at any depth**.
  The API uses keyset (`?after=` for products, `?before=` for orders).

---

## Conclusions

1. **Read-then-write oversells.** 1,000 buyers, 100 units: the naive version sold **~5×** the stock while the
   stock counter showed a healthy 0. The single conditional UPDATE (and `FOR UPDATE`) sold exactly 100, 6 of 6 runs.
2. **Idempotency keys work under concurrency:** 0 duplicate orders from 1,500 buyers who each sent their
   checkout twice at once (3,000 requests, 1,364 orders).
3. **A DB read costs ~3× throughput** vs. a no-op (1.36k vs 4.3k req/s on 1 CPU): the baseline for caching.
4. **Login is the most expensive endpoint by far:** ~22/s per CPU, and it slows *other* endpoints 8–11× at p99
   through CPU throttling, even though it never blocks the event loop.
5. **Query shape beats hardware:** keyset pagination and FULLTEXT turn 70–187 ms worst cases into ~1 ms.
6. **Open bottleneck found:** bursts of 2,000 simultaneous requests caused NGINX → Node connect timeouts (504).
   Investigate in Phase 2.
