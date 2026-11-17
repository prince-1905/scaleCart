# E11 — Payments as its own service: what the split costs, and what it buys

**Date:** 2026-11-17 · **Phase:** 8 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop (restarted with a reboot before the runs, see E11-0) |
| Shop | `apps/api`: 1 API replica (1 CPU) + 1 worker. Owns orders, stock, drops and the payment deadline |
| Payments | `apps/payments`: 1 replica (0.5 CPU, 256 MB). Owns Razorpay, `scalecart_payments` (its own MySQL user) |
| How they talk | **Sync:** payments → shop `GET /internal/orders/:id` at "Pay" (timeout 1 s, 1 retry after 100 ms, circuit breaker 5 failures → 10 s open). Shop worker → payments `POST /internal/orders/:id/reconcile` before cancelling an overdue order (timeout 3 s, breaker 5 → 30 s). **Async:** `payment.captured` (payments → shop) and `order.payment_result` (shop → payments) through RabbitMQ, both with an outbox (relay polls every 200 ms) |
| Script | `apps/api/scripts/e11-payments-split.ts <hop\|settle\|shopdown\|paydown\|breaker>`: stops, starts and pauses containers itself; reads order states straight from MySQL |
| Webhooks | Self-signed with the real webhook secret (same as E4c). "Pay" creates **real Razorpay test-mode orders** |
| Raw data | `load-tests/results/e11-*.txt` |

---

## E11-0 — Before any test: the network between the services broke

The first run of `hop` hung. Every call from payments to `http://api:3000` timed out, while the shop answered fine
through NGINX.

- Inside **every** container (and a brand-new one), name lookups through `getaddrinfo` with the `AI_ADDRCONFIG` hint
  hung. That is the call Node's `fetch` makes. Plain `getent hosts api` and `dns.lookup('api', {family: 4})` still
  answered in 0–47 ms, and `fetch` by IP worked (4 ms).
- So the shop and payments were each "healthy", but payments could not reach the shop. Every "Pay" would have failed.
- Restarting Docker Desktop got stuck on "starting". `wsl --shutdown` itself hung for 9+ minutes. A laptop reboot
  fixed it.
- After the reboot, Windows had reserved TCP ports **2945–3906** (WinNAT/Hyper-V). That blocked MySQL's host port 3307
  and Grafana's 3001. Fix (admin): `net stop winnat`, add excluded port ranges for 3307 and 3001, `net start winnat`.

**Lesson:** this failure mode didn't exist in the monolith. A function call can't fail a DNS lookup. In a split
system, the link between two healthy services is a new thing that can break, which is why every sync call has a
timeout and a breaker.

---

## E11a — The price of one network hop

What "Pay" needs from the shop: the order's amount, owner, status and deadline. Before the split this was one SQL query
in the same process. Now it is an HTTP call. 500 calls each (after 50 warm-up calls), run 3 times:

| Lookup | p50 | p95 | p99 | max |
|---|---|---|---|---|
| **In-process** (the monolith way: shop → MySQL, same query) | 0.17–0.26 ms | 0.31–0.51 ms | 0.42–1.05 ms | 1.05–8.13 ms |
| **HTTP hop only** (payments → shop `/health/live`, no DB) | 0.58–0.68 ms | 1.51–2.21 ms | 44.8–48.7 ms | 80.6–86.7 ms |
| **The real call** (payments → shop `/internal/orders/:id`) | 0.88–1.13 ms | 1.68–2.96 ms | 8.2–25.7 ms | 55.6–90.4 ms |

- At the median the hop costs **~0.7–0.9 ms**, about 4× the query alone.
- In the tail it is much worse: p99 **8–26 ms** vs **≤1 ms**. Network and HTTP add rare slow requests that a function
  call doesn't have.
- **In context:** the whole "Pay" request (which also creates a Razorpay order over the internet) took p50
  **90–94 ms**, p95 118–136 ms (60 Pays across E11b's 3 runs). The hop is ~1% of that at the median.

## E11b — Webhook → order paid, now through the queue

Before the split, the webhook request itself marked the order paid (one live webhook: **58 ms**, E4b). Now payments
saves the payment plus a `payment.captured` event (outbox), the relay publishes it, and the shop worker marks the order
paid. 20 orders per run, one webhook at a time, order state polled in MySQL every 10 ms:

| Run | Webhook answered (p50 / p95) | Webhook sent → order **paid** (p50 / p95 / max) | Not settled |
|---|---|---|---|
| `e11-settle-1` | 24.3 / 129.4 ms | **111.5** / 154.9 / 470.4 ms | 0 of 20 |
| `e11-settle-2` | 20.7 / 29.2 ms | **111.4** / 140.6 / 147.0 ms | 0 of 20 |
| `e11-settle-3` | 21.6 / 28.4 ms | **94.7** / 202.6 / 296.8 ms | 0 of 20 |

- Razorpay gets its answer **faster** than before (~21–24 ms): payments only writes two rows.
- The order turns paid **~95–112 ms** later. Most of that is the outbox relay, which checks every 200 ms (100 ms wait on
  average). That's **eventual consistency**: for ~0.1 s, Razorpay says "paid" and the shop still says "pending".
- Trade-off: polling more often → lower delay, more empty DB queries.

## E11c — The shop down for 60 s (API + worker stopped)

20 orders, Pay clicked for each (shop up). Then `docker compose stop api worker`, 20 webhooks, 60 s outage, start.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Stopping took (5 s graceful drain) | 5.9 s | 6.4 s | 5.5 s |
| **Webhooks during the outage** | **20 × 200** | **20 × 200** | **20 × 200** |
| Webhook time p50 / max | 53 / 457 ms | 64 / 1,148 ms | 16 / 25 ms |
| Browsing during the outage | 504 after 2.0 s | 504 after 2.0 s | 504 after 2.0 s |
| "Pay" during the outage | 503 `shop_unavailable` after 2.1 s | 503 after 2.1 s | 503 after 2.1 s |
| Orders during the outage | 20 pending | 20 pending | 20 pending |
| Events waiting in `orders.payment-captured` | **20** | **20** | **20** |
| **All 20 orders paid**, counted from the start command | p50 5.2 s, last 5.4 s | p50 4.0 s, last 4.1 s | p50 4.2 s, last 4.2 s |
| Queue afterwards | 0 | 0 | 0 |

- **60 of 60 payments accepted, 60 of 60 orders caught up, 0 lost.** In the monolith, the same outage means Razorpay
  gets errors and must retry (its retries came 321 s and 643 s apart in E4b).
- Catch-up time is mostly the worker booting (~4–5 s). After that the backlog drains fast: the median order and the last one were ≤171 ms apart.
- "Pay" can't work without the shop: it needs the amount. It fails clearly with a 503 ("try again shortly") instead of
  guessing. It took 2.1 s, which is the timeout + retry (see E11e).

## E11d — Payments down (~60 s)

`docker compose stop payments`. The shop kept working. 150 browse requests (product page / search, ~15/s, logged in)
and 5 cart + checkout rounds before and during the outage:

| | Run 1: payments up | Run 1: payments **down** | Run 2: up | Run 2: **down** |
|---|---|---|---|---|
| Browse: errors | 0 of 150 | **0 of 150** | 0 of 150 | **0 of 150** |
| Browse: p50 / p95 | 4.9 / 9.4 ms | 4.9 / 9.0 ms | 4.7 / 9.3 ms | 4.8 / 9.4 ms |
| Cart + checkout | 5 of 5 ok, p50 47 ms | **5 of 5 ok**, p50 48 ms | 5 of 5 ok, p50 111 ms | **5 of 5 ok**, p50 200 ms |
| "Pay" | — | 502 in **2.4 ms** | — | 504 after **2.0 s** |

- Shopping doesn't depend on payments. Checkout p50 differed in run 2 (111 vs 200 ms) but not in run 1: 5 samples each,
  within this laptop's noise. Only "Pay" fails.
- NGINX answered "Pay" in two ways: run 1 an instant 502 (name no longer resolves), run 2 a 504 after its 2 s connect
  timeout. I didn't pin down why the two runs differed.

**Overdue orders are not cancelled blindly.** 10 orders were back-dated past the 15-minute deadline while payments was
down. The expiry job must first ask payments "was it paid after all?":

| | Run 1 | Run 2 |
|---|---|---|
| Waited 45 s with payments down | **10 of 10 still pending** | **10 of 10 still pending** |
| Cancelled after payments came back | 10 of 10, **37.2 s** after start | 10 of 10, **25.6–25.9 s** after start |

Why so slow? Run 1, worker log:
```
11:49:06 cannot check payments for overdue orders: The operation was aborted due to timeout
11:49:18 circuit breaker for the payments service is now open          ← 5 timeouts (3 s each)
11:49:26 (payments started)
11:49:33 cannot check payments …: circuit open: not calling for another 15004 ms   ← payments is back, breaker still open
11:50:03 circuit breaker … half_open → closed
11:50:03 expired 10 unpaid order(s) in 511 ms
```
- The delay = the breaker's 30 s open time + the job's 30 s interval. That's harmless for a 15-minute deadline. It
  would matter for anything urgent.
- **Trade-off:** a breaker protects the caller, but it also keeps refusing for a while after the other side recovers.

## E11e — A frozen shop: does the circuit breaker fail fast?

`docker pause` on the shop's API container. Connections still open, but nothing answers: the worst kind of slow.
"Pay" on one order:

| | Run 1 | Run 2 |
|---|---|---|
| 8 clicks, one after another | **2,104–2,131 ms** × 5, then **3–4 ms** × 3 | **2,106–2,109 ms** × 5, then **4 ms** × 3 |
| 30 at once, breaker open | 30 × 503, p50 84 ms, max 126 ms | 30 × 503, p50 59 ms, max 87 ms |
| After 10 s: 3 clicks (first = trial call) | 2,376 ms, 220 ms, 3 ms | 2,121 ms, 11 ms, 2 ms |
| Shop unpaused, 11 s later | Pay **201** in 381 ms | Pay **201** in 324 ms |

- Each early click costs **2.1 s**: 1 s timeout + 100 ms pause + 1 s retry. After **5 failures the breaker opens** and
  customers get "try again shortly" in **~3 ms**, with no thread, socket or memory held for a dead shop.
- Every 10 s, one trial call checks whether the shop is back; it failed (~2.1 s) and the breaker reopened.
- Once the shop was back, the next Pay after the open time succeeded.
- Without the breaker, all 30 parallel clicks would each have held a connection for 2.1 s. Under real traffic that pile-up
  is how one slow service takes down the services that call it.

---

## Tests after the experiment

Shop: 59 unit, 160 end-to-end. Payments: 16 unit, 24 end-to-end. All passed on 2026-11-17, after the reboot.
The first full shop run right after the experiments had 1 failure: the rate-limit refill test (from Phase 6) got 200
where it expected 429. It refilled a token every 200 ms, so a slow request could earn one back. It passed 3 of 3 runs
on its own; I slowed it to one token per 500 ms. It then passed 3 of 3 alone, and the full suite passed (160 of 160).
Mutation checks during the build: random reply event id, cancelling an unknown order, no service-token check,
a repeated payment re-sending its event, no circuit breaker. Each one made a test fail.

## Left-over data

E11 marked 120 orders as paid with made-up payment ids (`pay_e11…`, webhooks self-signed, no money). They count in the
admin revenue numbers, like earlier load-test orders.
