# E3 — Email inside the request vs. outbox + RabbitMQ, and breaking things on purpose

**Date:** 2026-10-28 · **Phase:** 3 · **Status:** done

## Setup (applies to every run below)

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H (6P + 4E cores, 16 threads), 15.7 GB RAM, Windows 11, Docker Desktop 28.3.2 |
| API | 1 replica, 1.0 CPU, Fastify, cache on, backlog 4,096 |
| Worker | 1 replica, 1.0 CPU: outbox relay (polls every 200 ms, batches of 100) + email consumer (prefetch 20) + cleanup |
| Broker / mail | RabbitMQ 4.3.7 (quorum queues, 1 node), Mailpit v1.31.4 (fake SMTP server) |
| Database | MySQL 8.4.13 (`innodb_flush_log_at_trx_commit=1`, binlog on, `sync_binlog=1`) |
| Load | `load-tests/e3-checkout.js`: each iteration = put 1 unit in the cart + checkout. 400 different users; every run buys **one fresh product**, so all checkouts update the same stock row |
| Modes | `NOTIFY_MODE=sync`: checkout sends the email before answering (lab only). `NOTIFY_MODE=outbox`: checkout writes an event row in the order's transaction; the worker publishes and emails |
| Correctness checks | After each run the runner waited until the outbox and queues were empty, then counted: orders (MySQL) vs. emails in Mailpit (total and distinct subjects) |
| Raw data | `load-tests/results/<run-id>.*` (not committed) |

---

## E3a — Healthy mail server: does sending the email inside checkout cost much?

Stepped rates, 20 s each, two rounds per mode. Checkout latency only (the cart request is separate).

| Checkouts/s | Mode | Round 1 p50 / p99 ms | Round 2 p50 / p99 ms |
|---|---|---|---|
| 25 | outbox | 20.1 / 71.3 | 21.7 / 102.2 |
| 25 | sync | 22.9 / 88.2 | 22.5 / 90.1 |
| 50 | outbox | 26.2 / 115.6 | 24.5 / 121.4 |
| 50 | sync | 2,785 / 5,367 ⚠ | 26.5 / 139.3 |
| 100+ | both | overloaded: p50 1–17 s in every run | |

Runs: `e3-latency-outbox-20261028-174516`, `-175127`; `e3-latency-sync-20261028-174815`, `-175451`.

- With a **fast, local** mail server, sending inside the request adds only **~1–3 ms at p50**. The comparison doesn't
  justify the outbox *on speed* here. (A real email provider is a remote API taking tens to hundreds of ms.)
- Sync round 1 was already overloaded at 50/s; round 2 wasn't. Steps of 100/s and above were overloaded in **both** modes
  in every run. One API CPU (cart + checkout requests, one hot stock row) tops out somewhere between 50 and 100
  checkouts/s on this laptop. The run-to-run variation is too large to rank the modes by capacity.
- **No email lost or duplicated** in any of the four runs: orders = emails = distinct emails (4,928 · 3,943 outbox;
  5,355 · 7,431 sync).
- **Order → email delay with the outbox:** p50 **0.21 s / 0.24 s**, p99 **1.85 s / 1.63 s** (whole run, including
  overloaded steps). The outbox backlog never exceeded 41 events.

## E3b — The mail server freezes for 30 s

`docker compose pause mailpit` for 30 s in the middle of a 90 s run at 30 checkouts/s. The mail server stops answering
(connections hang) instead of refusing, which is the nastier kind of failure.

| | sync (email in the request) | outbox |
|---|---|---|
| Run | `e3-mailoutage-sync-20261028-175743` | `e3-mailoutage-outbox-20261028-180006` |
| Orders created | 2,231 | 2,602 |
| Checkouts that **failed for the customer** | **60** (46 × HTTP 500, 13 × 504 from NGINX after 30 s, 1 unclassified) | **0** |
| ...of which the order **was created anyway** | **all 60** (orders = successful checkouts + 60) | – |
| Emails delivered | 2,184 | **2,602** |
| Orders that **never got an email** | **47** | **0** |
| Duplicate emails | 0 | 0 |
| Checkout p50 / p95 / p99 | 1,745 / 23,844 / 28,084 ms | **33** / 5,528 / 6,572 ms |
| Email retries | – | ~32 (Prometheus estimate; went to the retry queue, came back after 5 s) |
| Order → email delay | – | p50 0.61 s, p99 37.7 s (waited out the outage) |

- **Sync = the dual-write problem, measured.** The order and the email are two systems with no shared transaction.
  46 customers were told "error" for orders that existed and were never emailed. 13 more got 504 because their request
  waited behind the frozen mail server. A retry with the same Idempotency-Key replays the stored order, so the email
  is never sent.
- **Outbox:** customers never noticed. The emails waited in the retry queue and **all 2,602 arrived** once the mail
  server was back, the slowest after ~38 s.
- The outbox run's p95/p99 (5–7 s) came from a **database stall unrelated to email** (see E3e), not from the mail outage.

## E3c / E3d — Kill the worker, restart RabbitMQ

Steady 40 checkouts/s for 90 s, outbox mode.

| | Worker killed (`SIGKILL`) for ~36 s | RabbitMQ restarted (~3 s) |
|---|---|---|
| Run | `e3-killworker-20261028-180231` | `e3-restartrabbit-20261028-180436` |
| Checkout failures | **0** | **0** |
| Orders | 3,278 | 3,600 |
| Emails delivered | **3,278** | **3,600** |
| Lost / duplicate emails | **0 / 0** | **0 / 0** |
| Outbox backlog peak | 322 events | 379 events |
| Order → email delay p50 / p99 | 21.4 s / 59.2 s | 0.18 s / 24.6 s |
| Checkout p50 / p99 | 54 / 13,493 ms | 26 / 151 ms |

- The API doesn't use RabbitMQ or the worker, so **checkout kept working** through both failures. Events simply waited
  in the outbox (in MySQL) and were sent when the worker or broker came back.
- **Killed mid-work, nothing lost:** unacknowledged messages were redelivered, and unpublished outbox rows were
  published again. No duplicate email reached Mailpit. (Duplicates are possible in theory: crash between "sent" and
  "recorded". The consumer's dedupe table makes them rare, not impossible.)
- The kill-worker run's checkout p99 (13.5 s) is the same database stall as E3e, not the worker.

## E3e — Investigation: what were the multi-second checkout stalls?

Three runs had checkout p99 of 6–13 s, but the API's event loop was only ~30–40% busy and not CPU-throttled:
requests were **waiting**, not working. Server-side timelines (`http_server_requests_in_flight`) showed up to 337
requests piling up.

1. **Not the outbox or worker.** A control run with **nothing broken** (`repro-plain-20261028-181105`, 40/s) showed the
   same stall near the end: API-side checkout p99 2.4 s, 60 requests in flight.
2. **Who waits for whom:** sampling `sys.innodb_lock_waits` during a stall (`repro-locks-20261028-180828`): up to
   **10 checkouts waiting for the stock row lock** (`UPDATE stock … WHERE product_id = <the product>`), blocked by a
   transaction whose current statement was **`COMMIT`**.
3. **Why is COMMIT slow?** Each commit waits for the redo log and the binlog to reach the disk (`flush_log_at_trx_commit=1`,
   `sync_binlog=1`). MySQL's file-I/O statistics (`performance_schema.file_summary_by_event_name`, since server start):

   | File | Writes/fsyncs | Average | **Slowest** |
   |---|---|---|---|
   | InnoDB redo log | 1,137,933 | 0.73 ms | **3,927 ms** |
   | Binary log | 362,066 | 1.95 ms | **2,258 ms** |

   `Innodb_log_waits = 0` and `Innodb_buffer_pool_wait_free = 0`, so the redo log wasn't full: the **disk itself**
   occasionally took seconds to confirm a write. That's Docker Desktop's virtual disk on a busy laptop, shared with
   RabbitMQ, Mailpit and Windows.

**Mechanism:** checkout holds the product's stock row lock until COMMIT completes. One 2–4 s disk flush freezes
**every** buyer of that product behind it. Hot-row designs are only as fast as their commit.

**What would fix it (not done here):** fast disks with reliable fsync (cloud SSD/NVMe); fewer fsyncs per commit
(group commit already helps; `innodb_flush_log_at_trx_commit=2` trades up to ~1 s of data on an OS crash); or
avoid one hot row per product for drops (split stock into buckets, or reserve in Redis and settle in MySQL).
A timed proof (each stall matched to a specific slow fsync) wasn't collected: the evidence is the blocked-by-COMMIT
lock waits plus the measured worst-case fsync times.

---

## Conclusions

1. **Outbox: zero customer-visible failures and zero lost emails** across a frozen mail server, a killed worker and a
   restarted broker (9,480 orders, 9,480 emails, 0 duplicates in E3b–d).
2. **Email in the request: the dual-write problem is real.** A 30 s mail outage gave 60 customers an error, all 60 orders
   existed anyway, and 47 were never emailed.
3. On the happy path with a local mail server, the speed difference is small (~1–3 ms p50). The outbox is about
   **failure isolation and correctness**, not raw speed.
4. **Price of the outbox:** emails are eventual. Normally ~0.2 s, but up to ~1 min while something is down.
5. The worst checkout latency came from a **slow disk under a hot row lock**, found by checking a no-failure control run
   before blaming the new code.
