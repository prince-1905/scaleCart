# E16 — A MySQL read replica: offload, lag, stale reads, failures

**Date:** 2026-11-25 · **Phase:** 13 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop. The charger kept reconnecting (Windows event 105): every run was checked against the log, and runs with an event inside them are left out (named below) |
| Primary | `mysql` 8.4.13, 2 CPUs, `gtid_mode=ON`, binary log kept 1 day, clone plugin |
| Replica | `mysql-replica`, same image, 2 CPUs, async GTID replication (`SOURCE_AUTO_POSITION=1`), `super_read_only=ON`. First copy by the clone plugin: **50 s** for the whole server (~180 MB of shop data) |
| Routing (shop) | Replica when healthy: product list, admin dashboard + order list + order detail, MySQL search fallback, a customer's own orders (with read-your-writes). Always the primary: writes, cart, checkout, prices, stock, payments, and filling the product-page cache |
| Lag guard | Worker stamps `replication_heartbeat` on the primary every 250 ms; the shop reads it from the replica every second. More than 2 s behind, or no answer within 1 s → reads go to the primary |
| Bulkhead | Reads that should go to the replica but can't: at most `READ_FALLBACK_CONCURRENCY` (4) at once on the primary, the rest a quick 503 `read_busy` (added during E16a, see below) |
| Read-your-writes | After checkout: the primary's `gtid_executed` is kept in Redis for that customer (10 s). Their order reads run `WAIT_FOR_EXECUTED_GTID_SET(…, 0.05)` on the replica: has it → replica, else primary |
| Raw data | `load-tests/results/e16-*` |

---

## E16-0 — Proof it's a copy that can't drift

- A row written on the primary was read on the replica; a database dropped on the primary disappeared on the replica.
- `INSERT` on the replica **as root**: `ERROR 1290 … running with the --super-read-only option`.
- The first version of the lag check failed with a SQL syntax error: `lag` is a reserved word in MySQL 8 (window
  function). The safety net worked: the replica was marked "down" and every read stayed on the primary. Renamed.

## E16b — How far behind is the replica?

`apps/api/scripts/e16-replica.ts lag`: every 100 ms write a unique marker on the primary, then poll the replica until
it shows it. Lag = commit answered → visible on the replica.

| Run | Markers | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Idle, run 1 (60 s) | 534 | **4.4 ms** | 12.2 ms | 19.7 ms | 30.9 ms |
| Idle, run 2 (60 s) | 481 | **12.7 ms** | 40.2 ms | 86.1 ms | 223 ms |

- **A few ms to tens of ms.** It varies between runs; the tail reaches a few hundred ms. A commit on the primary
  alone takes ~22 ms here (the disk sync of Docker Desktop's virtual disk), and the replica has to save each change
  to its own disk too.
- **Measuring trap:** the first trial polled with `sleep(2)`, which really sleeps ~14 ms on Windows (timer
  resolution): it reported p50 ~19–25 ms. Polling back to back (~1.6 ms per query) fixed the resolution.
- Two runs during the mixed load (p50 5.3–5.9 ms, p99 41–79 ms) had charger events inside them: not counted.

## E16c — The stale-read bug: "I just ordered, but My orders is empty"

`e16-replica.ts stale 100`: 100 checkouts ("Buy now"), each followed **immediately** by `GET /orders` through the shop.

| Read-your-writes | Run 1 | Run 2 |
|---|---|---|
| **Off** (order reads use the replica blindly) | **18 of 100** missed the new order | **76 of 100** missed |
| **On** (wait for the customer's GTIDs, else primary) | **0 of 94** missed | **0 of 100** missed |

- With only milliseconds of lag, the request after checkout arrives faster than the copy: 18–76% of customers would
  have seen an empty list.
- With the fix all reads still came from the replica (`ryw_caught_up` 94 of 94): the replica had the order by the time
  it was asked. The wait cost **0.8 ms on average** (73 ms over 94 waits). "My orders" p50 5.5–6.6 ms off vs
  5.9–7.2 ms on.
- (6 checkouts in "on" run 1 were refused by the per-customer checkout rate limit: the same 10 customers ran again
  right after "off" run 1.)

## E16a — Does it take load off the primary? (and a cascade found on the way)

`load-tests/e16-offload.js`, 60 s: 100 product-list pages/s, 50 "My orders"/s, STATS_RATE admin dashboard stats/s (a
full scan of 69,942 orders, ~104 ms of MySQL CPU each), and 5 "Buy now" checkouts/s (always the primary). CPU =
`docker stats` average (100% = one core).

### First series: the replica overloaded and was declared "down"

Heavy load (10 stats/s), replica on, **no bulkhead yet**: the replica ran at 165–175% CPU, its 1 s heartbeat check
timed out, the shop marked it **down** and sent its reads to the primary: about half of all reads in one run
(Prometheus: 2,850 catalog + 1,405 order reads to the primary with reason "down", 3,124 + 1,694 to the replica). The
primary stayed at **170–183%** CPU, as if there were no replica. Same lesson as E15b: a fallback that moves ALL the
load to the component checkout needs is a cascade. (This series also had a script bug: every checkout was refused
with 400 because the k6 idempotency key contained a dot. Only its CPU and routing numbers are used here.)

**Fix:** the bulkhead. When the replica can't be used, at most 4 of its reads run on the primary at once; the rest get
a quick 503 `read_busy`.

### Second series (fixed script), clean runs only

| Load · configuration | Runs | Primary CPU | Replica CPU | Checkout p50 | Dashboard stats p50 | Errors |
|---|---|---|---|---|---|---|
| Heavy (10 stats/s) · replica **off** | 3 | 176–191% | 16–27% | **30.2 s** (timeouts) | 14.6–22.0 s | 202–1,032 |
| Heavy · replica on, **no bulkhead** (limit 1000) | 2 | 155–190% | 121–148% | **22.4–29.4 s** | 3.2–3.8 s | 56–97 |
| Heavy · replica on, **bulkhead 4** | 2 | **105–117%** | 148–186% | **0.62–0.74 s** | 0.45–0.90 s | 4,078–4,100 (quick 503s) |
| Moderate (3 stats/s) · replica **off** | 2 | **82–84%** | 15–20% | 92–136 ms | 188–208 ms | 0 |
| Moderate · replica **on** | 3 | **19–27%** | 78–98% | 50–241 ms | 182–274 ms | 8–88 |

Left out (charger event inside): heavy-on-no-bulkhead run 1, heavy-on-bulkhead run 2, moderate-off runs 2 and 3.

- **Moderate load: the primary's CPU drops from 82–84% to 19–27%.** The dashboard scans and the browsing moved to the
  copy; checkout's database has room again.
- **Heavy load:** together the two databases can't carry 10 full scans/s. Without the bulkhead the replica "fails"
  and the primary takes everything: checkouts time out (p50 22–29 s), no better than having no replica. With the
  bulkhead the primary stays at ~105–117% and **checkout p50 is 0.6–0.7 s instead of 30 s**. The price: ~4,100 browse
  and dashboard requests per run get a quick 503 (Prometheus: ~3,800 "refused" in one run).
- Tail latencies (p95/p99) were very noisy on this laptop in every configuration (seconds, even at moderate load with
  the primary at 20%); they aren't used for claims. The primary's CPU was consistent across runs.

## E16d — The replica fails under traffic

`load-tests/e16-replica-ops.mjs`: 50 product-list pages/s + 10 "My orders"/s from 10 customers; the replica's
container stopped for 30 s (`down`), or its applier paused for 30 s so it falls behind (`pause`).

| Run | Phase | Answered | Failed |
|---|---|---|---|
| down 1 | replica stopped (42 s) | **2,506 of 2,516** | 10 × 503 (bulkhead) |
| | replica starting | 1,857 of 1,859 | 2 × 503 |
| pause 2 | replica paused (30 s) | **1,822 of 1,824** | 2 × 503 |
| | resumed | 1,800 of 1,820 | 20 × 503 |

- **Switching:** stop → "ok → down" 1.1 s after the stop began; back to "ok" **7 s** after the start command.
  Pause → "lagging" 2.2–3.2 s after the pause (the 2 s limit); back to "ok" 3.4–14 s after resuming.
- p50 stayed 6.5–6.8 ms while the primary served the reads.
- **Four other runs had real failures, and the replica is not the cause I can prove:** down 2 (418 requests with no
  answer in 5 s after the restart), down 3 (930 while stopped), pause 1 (59 + 268 no answer, 475 + 168 × 503), pause 3
  (**257 no answer in the "before" phase, before the replica was touched**). Traces show the time spent waiting on
  the rate limiter's Redis call (~3.1 s, the same in every slow trace), and the shop's event loop froze for 0.7–3.4 s
  at those moments (heap normal, no GC pressure, no Windows events). Pause 3's early failures came without a freeze,
  like E13d's bursts that never reached NGINX. Laptop/Docker instability; not claimed either way.

---

## Tests

On 2026-11-25: shop **77 unit**, **152 end-to-end** (`replica.e2e-spec.ts`: 5 tests against the real replica:
routing, read-your-writes with the applier paused, too far behind, replica unreachable, bulkhead).
- Mutation-checked: checkout not remembering the write, read-your-writes trusting the replica without waiting (both
  fail the read-your-writes test, which also checks the replica really lacks the order); no lag guard (the "too far
  behind" test); no bulkhead (the bulkhead test).
- The full e2e suite now runs 4 files at a time (`maxWorkers: 4`): all 11 at once next to the stack failed 3–5 files
  per run (503 health checks, RabbitMQ connect timeouts, timing tests). After all fixes, 3 full runs with 4 files at a
  time: 1 fully green (151/151), 1 with an old phase3 email-timing failure, 1 with 3 load-sensitive failures (2
  rate-limit tests, where a slow Redis sends the limiter to its per-process backup bucket and 20 instead of 10 get
  through, the documented E9 trade-off; 1 search test answered by the fallback). Those files pass alone (rate-limit +
  search: 25 of 25).
- Identity 16 unit / 26 end-to-end and payments 18 unit pass (identity's tests now follow `REDIS_PORT`: port 6379 is
  taken by another project's Redis on this machine, the Compose Redis moved to 6380).
- **Bug found by the reorder (Phase 12 code):** other suites' workers indexed products before the search suite created
  its alias, and OpenSearch auto-created a plain index named `test-products`, after which the alias could never be
  created. The same could happen in production if OpenSearch is slow at the worker's start. Fixed: writes use
  `require_alias` and create the alias if it's missing; index creation got a 30 s timeout instead of the 1 s search
  timeout.
- Found, not fixed (Phase 3 code, owner to decide): the email worker sends first and records "sent" after. Under heavy
  test load two redeliveries of the same event both passed the check: 3 emails instead of 1.
