# E6 — A Redis "door counter" in front of the hot stock row

**Date:** 2026-11-04 · **Phase:** 4.6 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker 28.3.2 (Docker Desktop) |
| API | **1 replica, 1 CPU**, Fastify · MySQL 8.4.13 · Redis |
| Load | `load-tests/e5-drop.js MODE=direct STOCK=100`: **1,000 buyers, 100 in stock**, all admitted at once (the waiting room lets everyone in, so the stock row takes the full rush) |
| Switch | `DROP_STOCK_GATE=false\|true` (API restarted between modes) |
| Stall | `STALL_MS=5000`: the lab endpoint holds the product's stock row locked for 5 s, like a commit stuck on a slow disk (E3e/E5) |
| Disk check | MySQL file-I/O stats reset before each run, slowest redo/binlog write read after |
| Raw data | `load-tests/results/e6*-<run-id>.*` (not committed) |

**What the gate is:** a counter in Redis per drop, loaded from MySQL's stock. Checkout takes a unit from it in one atomic
Lua step ("take 1 only if ≥ 1 is left").
- **At 0:** "sold out", answered without touching MySQL.
- **Above 0:** the buyer goes on to MySQL, whose conditional `UPDATE` still decides.

So a wrong counter can only make us sell **fewer**, never more. It's reset from MySQL every 10 s, units are given back
when a checkout fails after the gate, and it fails open if Redis is down (checkout goes straight to MySQL).

---

## E6a — First version: the gate saved nothing

Gate placed after pricing and after the `drop_purchases` INSERT. 100 created and 900 sold out in every run.

| Run | Gate | Stall (lock wait / held) | "Sold out" p50 / p95 | Created p50 | In flight (max) |
|---|---|---|---|---|---|
| `e6-gateoff-…122502` | off | – | 1,601 / 1,785 ms | 1,043 ms | 185 |
| `e6-gateon-…123019` | on | – | **1,798** / 2,475 ms | 1,081 ms | 339 |
| `e6-gateoff-stall-…122128` | off | 341 / 5,001 ms | 2,308 / 5,541 ms | 1,532 ms | 183 |
| `e6-gateoff-stall-…122319` | off | 1,492 / 5,000 ms | 8,878 / 10,262 ms | 4,645 ms | 961 |
| `e6-gateon-stall-…122649` | on | 1,433 / 5,001 ms | 8,269 / 9,420 ms | 5,559 ms | 983 |
| `e6-gateon-stall-…122837` | on | 4 / 5,001 ms | 1,573 / 1,977 ms | 1,447 ms | 303 |

- **"Sold out" was no faster than a real purchase**, even without a stall.
- **Why** (from the checkout order): before reaching the gate, every buyer read the cart, read the prices and
  **inserted + committed** the one-purchase-per-customer row, and a sold-out buyer then **deleted** it again. That's two
  MySQL writes per loser. The gate only skipped the stock row, which wasn't the main cost.
- The stall started unevenly (lock wait 4–1,492 ms), because the stall request raced the buyers for the row.

**Fix:** move the gate to the front. Checkout now does:
1. read the cart lines
2. check the drop rules: quantity limit and pass (no database needed)
3. ask the **gate**
4. only then: prices → `drop_purchases` INSERT → stock reservation

The stall now starts 0.5 s **before** the sale (`STALL_AT=-0.5`), so it holds the row before any buyer arrives.

## E6b — Gate first: the result

100 created and 900 sold out in every run; stall lock wait 1–2 ms, held 5,001–5,002 ms.

| Run | Gate | "Sold out" p50 / p95 / p99 | Created p50 / p95 | In flight (max) | Slowest disk write (redo / binlog) |
|---|---|---|---|---|---|
| `e6b-gateoff-stall-…123514` | off | 3,980 / 4,537 / 4,618 ms | 4,640 / 4,743 ms | **1,001** | 537 / 139 ms |
| `e6b-gateoff-stall-…123706` | off | 4,228 / 4,607 / 6,707 ms | 4,678 / 4,814 ms | **1,001** | 143 / 26 ms |
| `e6b-gateon-stall-…124043` | on | **131 / 278 / 287 ms** | 4,556 / 4,667 ms | **120** | 127 / 31 ms |
| `e6b-gateon-stall-…124223` | on | **387 / 579 / 3,983 ms** | 4,606 / 4,731 ms | **161** | 98 / 116 ms |
| `e6b-gateoff-…123841` (no stall) | off | 4,202 / 4,761 / 5,571 ms | 4,772 / 4,976 ms | 984 | 214 / 233 ms |
| `e6b-gateon-…124357` (no stall) | on | 952 / 1,508 / 4,500 ms | 1,283 / 1,817 ms | 263 | 137 / 28 ms |

- **During a 5 s jam, the 900 losers got "sold out" 10–30× faster** (p50 131–387 ms vs 3,980–4,228 ms), and the API
  held 120–161 requests instead of all 1,001.
- **The 100 winners still waited for the jam** (created p50 ~4.6 s in both modes). That's expected: they really need the
  row. The gate only takes the losers out of its queue. Removing the row from the path entirely would mean making
  Redis the stock itself, which can oversell if Redis loses data (not done, on purpose).
- **Without a stall** (one run each): "sold out" p50 952 ms with the gate vs 4,202 ms without. But the same no-gate
  case gave 1,601 ms in E6a, so these single runs vary a lot. Even with the gate, ~1 s for "sold out" is because
  1,000 requests at once saturate the 1-CPU API (auth, cart read, queue calls): the next bottleneck.
- **Never oversold:** exactly 100 orders in all 12 runs.

## Correctness tests (`test/drops.e2e-spec.ts`, 16 tests)

- **Sold out while the MySQL stock row is locked by another transaction:** the gate answers in < 2 s without waiting
  for the lock.
  - Mutation check: ignoring the gate's answer made this test hang on the lock and fail (30 s timeout).
  - An earlier version of the test only checked a metric and **did not** catch that mutation, so it was replaced.
- **A wrong counter can't oversell:** the counter says 4 while MySQL says 0, so the buyer is let through and MySQL
  refuses. The reset then sets the counter to 0, and the next buyer is answered by the gate.
- **Redis down:** checkout still works through MySQL (existing test).
