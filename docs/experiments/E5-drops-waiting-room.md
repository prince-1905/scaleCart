# E5 — Drops: 1,000 buyers at the same second, with and without a waiting room

**Date:** 2026-11-03 · **Phase:** 4.5 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H (6P + 4E cores, 16 threads), 15.7 GB RAM, Windows 11, Docker 28.3.2 (Docker Desktop) |
| API | **1 replica, 1 CPU**, Fastify, backlog 4,096 (same as the E2 burst) |
| Database / Redis | MySQL 8.4.13 (`flush_log_at_trx_commit=1`, `sync_binlog=1`) · Redis (tickets and the line) |
| Load | `load-tests/e5-drop.js`: **1,000 different buyers**, each with the drop product in the cart, act at the drop's start. Connections are opened before the start. **Stock = 1,000**, so every checkout does real work |
| Modes | **direct**: the drop admits 10,000/s, so everyone is let in at once (≈ the E2 burst) · **room**: time-based waiting room, 50 tickets/s · **window**: "one out, one in", at most 50 called buyers at once |
| Stall (E5b) | `STALL_MS=5000`: 5 s after the start, the lab endpoint `POST /lab/hold-stock-lock` holds the product's stock row locked for 5 s, the same deliberate jam in every mode |
| Disk check | Before each E5b run, `performance_schema.file_summary_by_event_name` is reset; after it, the slowest redo-log and binlog write is read |
| Raw data | `load-tests/results/e5*-<run-id>.*` (not committed) |

How the waiting room works:
- **Joining:** the buyer calls `POST /drops/:id/queue`. Redis hands out a ticket with one atomic Lua script (one number per customer; asking again returns the same number).
- **Calling numbers:**
  - *Room:* tickets up to `seconds since start × rate` are called. Pure arithmetic, so no background job is needed.
  - *Window:* the next ticket is called when a place frees up. A buyer's place has a 60 s lease and is freed when they buy or sell out.
- **The pass:** a called buyer gets a signed pass (HMAC, short-lived), and checkout of a drop product requires it.
- **One purchase per customer:** enforced by the MySQL primary key `drop_purchases (drop_id, user_id)`.

---

## E5a — No stall: is the waiting room worth it? (4 runs each, 1,000 of 1,000 orders in all 8)

| Run | Checkout p50 / p99 | Time from start to order: median / max | Errors |
|---|---|---|---|
| direct `e5-direct-…154404` | 3,660 / 5,925 ms | 6.5 / 9.8 s | 0 |
| direct `…155258` | 3,786 / 5,131 ms | 5.9 / 8.7 s | 0 |
| direct `…154747` ⚠ | 25,582 / 27,241 ms | 28.3 / 31.3 s | 0 |
| direct `…155633` ⚠ | 16,219 / 27,588 ms | 13.8 / 31.1 s | **259 × 504** (NGINX's 30 s limit), 3 × 503 on the queue |
| room 50/s `e5-room50-…154547` | **264 / 1,163 ms** | 12.0 / 20.8 s | 0 |
| room 50/s `…155440` | **252 / 1,101 ms** | 12.1 / 20.8 s | 17 × 503 on the queue (retried, all got in) |
| room 50/s `…154955` ⚠ | 5,045 / 15,582 ms | 17.3 / 37.0 s | 0 |
| room 50/s `…155845` ⚠ | 3,606 / 10,578 ms | 15.2 / 32.2 s | 0 |

⚠ = slow runs (4 of 8, two per mode).

- **On a healthy run, the waiting room makes checkout ~14× faster at p50 (≈ 0.26 s vs ≈ 3.7 s)** and keeps the API calm:
  at most 26–288 requests in flight vs 881–917 in direct mode.
- **But everyone waits longer in total** (median 12 s vs 6 s). The line moves at 50/s, while the API alone served
  1,000 direct buyers in ~9 s (~110/s). **50/s was too careful**; the admit rate should come from measured capacity.
- **Ghost orders:** in direct `…155633`, 259 buyers got a 504, but the stock went from 1,000 to 4 (**996 orders exist**,
  741 answered 201). So **~255 customers were shown an error for an order that was created.** Retrying with the same
  idempotency key would return their order, but they don't know that.
- **The slow runs were waiting, not working:** API CPU only 0.34–0.54 cores while up to 1,000 requests were in flight
  (Prometheus), the same signature as E3e. MySQL's slowest redo-log write during the first four runs was **5,548 ms**
  (avg 1.3 ms). For `…155845` the per-run maximum was only **319 ms**, so not every slow run is explained by a disk
  stall. **Ruled out:** the payment-timeout job (its rounds ran after those sales ended) and CPU throttling (similar in
  all runs). The exact cause of each slow run isn't proven.
- **Where the time-based room failed:** it keeps admitting 50/s **during** a stall. In-flight grew to 438 in
  `…155845` vs 26 in a healthy run. That's what E5b tests with a stall made on purpose.

## E5b — The same 5 s stall, on purpose, in every mode

Clean series `e5c-*` (an earlier series `e5b-*` had two test-script bugs and was discarded, see below).
1,000 of 1,000 orders in every run, and **no checkout errors**. Queue 503s are listed; every buyer retried and got in.

| Run | Checkout p50 / p95 / p99 | Time to order: median / p95 / max | In flight (max, all routes) | Queue 503s | Slowest disk write (redo / binlog) |
|---|---|---|---|---|---|
| direct + stall | 3,606 / 4,445 / 4,693 ms | 6.0 / 8.5 / 8.9 s | 839 | 0 | 194 / 273 ms |
| room 50/s + stall #1 | 371 / 3,321 / 4,048 ms | 12.2 / 20.1 / 21.6 s | 198 | 8 | 857 / 1,612 ms |
| room 50/s + stall #2 | 463 / 4,620 / 4,690 ms | 12.3 / 20.0 / 20.6 s | 325 | 5 | 223 / 355 ms |
| **window 50 + stall #1** | 510 / **1,820** / 4,630 ms | 30.4 / 50.6 / 53.0 s | 72 | 10 | 205 / 408 ms |
| **window 50 + stall #2** | 152 / **1,066** / 4,550 ms | 33.6 / 54.2 / 56.8 s | 272 | 13 | 30 / 31 ms |
| window 50, no stall | 265 / 2,415 / 3,216 ms | 24.8 / 42.9 / 44.4 s | 142 | 45 | 253 / 492 ms |

In direct mode the stall itself had to wait **4.2 s** for the row (checkouts held it), so it hit later than in the
other runs (there it waited 1–8 ms).

- **"One out, one in" limits who is caught by the stall:** checkout **p95 1.1–1.8 s vs 3.3–4.6 s** for the time-based
  room. At most 50 buyers are at the counter during the jam, instead of ~250 (50/s × 5 s). p99 is the same (~4.6 s):
  whoever is at the counter during the jam waits for it.
- **But the line moves about half as fast:** ~1,000 buyers in 44 s (~23/s), vs 50/s. A freed place stays empty until the
  next called buyer *asks* and finds out it's their turn (the client polls every 0.5–5 s). It also makes about
  **2× more queue calls** (5,700–7,400 vs ~3,400).
- So neither version wins outright. The fix for the window's weakness is to **push "your turn" to the browser**
  (SSE/WebSocket) instead of polling, or to call slightly more than 50. Not built yet.
- "In flight" counts every request, including queue polls, so it isn't a pure measure of checkouts.

## E5c — Findings along the way

**1. The server clock jumps (Docker on this laptop).** In the discarded series, **39 buyers holding a valid pass were
told "drop not started"**, and a 5 s lock reported 2,273 ms. Measured right after:
- The API container's `Date.now()` was ahead of the host by **+342, +577, +829 ms** over ~6 s.
- `dmesg` showed `systemd-journald: Time jumped backwards` at 5,947 s, 5,975 s, 6,002 s, 6,029 s and 6,057 s
  (**every ~27 s**).

So the VM clock runs fast and is stepped back.

- **Fix:** a valid pass proves the drop has started (passes are only issued after the start), so checkout no longer
  re-checks the clock when a pass is present (test: "a valid pass wins over the clock"). Durations in the lab endpoint
  now use `performance.now()`.

**2. "Waiting room unavailable" under load.** 5–53 queue calls per run got 503. Redis wasn't down: the API was so busy
that a Redis reply took longer than the 200 ms limit, and the waiting room **fails closed** by design (no tickets → the
drop pauses; stock is in MySQL, so it never oversells). Clients retried after 1 s. A longer timeout for queue
calls would reduce this.

**3. Test-script bugs (the discarded `e5b-*` series and the first direct run).**
- An idempotency key shorter than 8 characters: 99 buyers were rejected with 400.
- The stall scenario took a VU number, so one buyer had no login and got 196 × 401.

Both were fixed and the affected runs were thrown away.

## Correctness tests

- `test/drops.e2e-spec.ts` (14 tests) checks:
  - only admins create drops
  - the line opens 10 min early, and checkout before the start → `drop_not_started`
  - one ticket per customer, with 20 parallel joiners getting tickets 1–20
  - the line moves at the admit rate
  - a pass is required, the quantity limit applies, and a second purchase → `drop_already_bought`
  - someone else's pass or a forged pass → 403
  - a retry with a refreshed pass → replay, not a second purchase
  - sold out → the claim is released
  - "one out, one in": A and B in, C waits, then C gets in after A buys; sold out also frees a place
  - a valid pass wins over the clock
  - Redis down: the line returns 503, but an already-issued pass still works
- **Mutation checks:**
  - no pass check → 2 tests failed
  - no per-customer claim → 1 failed
  - not freeing the place after buying → 2 failed
- Unit: the line arithmetic, and pass sign/verify (tampered, expired, other key).
