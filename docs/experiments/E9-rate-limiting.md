# E9 — Rate limiting: can one greedy client still hurt everyone else?

**Date:** 2026-11-14 · **Phase:** 6 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop |
| API | **1 replica, 1 CPU**, Fastify · MySQL 8.4.13 · Redis · NGINX 1.30.6 in front |
| Load | `load-tests/e9-rate-limit.js`, 60 s, open model. **Shoppers:** 50 logged-in users, together 50 req/s (product page 50%, search 30%, cart 20%). **Attacker:** 1 logged-in user, **1,500 uncached searches/s** (a scraper) |
| Limits | API token bucket per user: `RATE_LIMIT_DEFAULT=60:20` (bursts of 60, then 20/s). For setup's 51 logins from one IP: `RATE_LIMIT_AUTH=1000:100` (default is 10:0.2) |
| Switch | `RATE_LIMIT_ENABLED=true\|false` (API restarted between modes) |
| Raw data | `load-tests/results/e9-*` (runs that ran stale code are prefixed `stale-`) |

**What the limiter is:** a token bucket per caller in Redis, in one Lua script.
- Each request takes 1 token. An empty bucket → `429` + `Retry-After`.
- Tokens come back at the refill rate, up to the capacity. Nothing runs on a timer: the script adds
  *time passed × rate* when the next request arrives, using Redis's clock.
- Logged-in callers are counted by user id, logged-out ones by IP (`X-Real-IP` from NGINX, `TRUST_PROXY=true`).

---

## E9a — The first baseline found a bug: shoppers were limited with no attacker

No attacker, only 50 shoppers at 1 req/s each, far below their 20/s.

| Run | Shopper requests refused with 429 |
|---|---|
| `e9-baseline-…171343` | **1,119 of 3,000** (37%) |
| `stale-e9-baseline-…171809` (same code, repeated) | **1,110 of 3,000** |

- **Cause:** product pages and search are `@Public()`. The AuthGuard returned early on public routes without reading
  the token, so `req.user` was empty and the limiter counted all 50 shoppers **by their one shared IP** (20/s for 50/s).
- **Fix:** on public routes, a valid token still sets `req.user`. A missing or bad token is no error there.
- **Test:** `public pages count a logged-in shopper by user too` failed without the fix and passes with it.
- **After the fix** (`e9-baseline-…172114`): **0** refused, shoppers p50 / p95 / p99 = **4.0 / 9.8 / 22.4 ms**, 0 errors.
- Real-world meaning: shoppers behind one office or mobile-carrier IP would have blocked each other.

## E9b — Limiter off vs on (API only)

| Run | Shopper p50 / p95 ms | Shopper errors (of ~3,000) | Attacker searches served | API event loop busy (max) |
|---|---|---|---|---|
| no attacker `…172114` | 4.0 / 9.8 | 0 | – | 0.16 |
| **off** `…172540` | 1,945.8 / 10,024.3 | **2,161** | 18,959 | 1.00 |
| **off** `…172656` | 5,071.2 / 10,011.5 | **1,033** | 18,544 | 1.00 |
| **on** `…172220` | 21.9 / 4,463.8 | 0 | 6,983 | 1.00 |
| **on** `…172326` | 756.7 / 10,000.7 | 355 | 10,089 | 1.00 |

Errors are mostly k6's 10 s timeouts.

- **Off:** every attacker search reached MySQL. A third to two-thirds of the shoppers' requests failed.
- **On:** much better (0–355 errors), but shoppers still waited seconds. Two reasons:
  1. **Refusing costs work too.** 1,500 req/s still went into Node; each needed the JWT check, a Redis call and an
     error response. That alone kept the one CPU's event loop **100% busy**.
  2. **Fail open leaked the attacker in.** The busy API read Redis's replies after the 200 ms timeout, and the first
     version then let the request through. Metric over these two runs: **18,373** requests allowed as "Redis
     unavailable". That's why the attacker got 6,983–10,089 searches instead of ~1,260 (60 + 20/s × 60 s).

## E9c — Two fixes: refuse at the edge, and a backup bucket in each pod

1. **NGINX edge limit** (`limit_req`), keyed by the `Authorization` header like an API gateway keys by API key:
   50 req/s per token, burst 100, refused by NGINX with the same JSON 429. That's looser than the API's 20/s, so normal
   use never hits it. Requests without a token aren't counted there.
2. **Local backup bucket:** when Redis can't answer in time, the pod's own in-memory token bucket decides instead of
   "allow". Trade-off: while Redis is out, N pods allow up to N × the limit. That's still a limit.

| Run | Shopper p50 / p95 / p99 ms | Shopper errors | Attacker served | Attacker refused | Attacker p50 ms | API event loop busy (max) |
|---|---|---|---|---|---|---|
| `e9-edge-…180926` | 12.3 / 10,000.4 / 10,000.9 | 478 | 804 | 46,306 | 1.1 | 1.00 (see below) |
| `e9-edge-…181046` | **3.7 / 7.2 / 22.3** | **0** | 1,297 | 88,704 | 0.6 | 0.26 |
| `e9-edge-…181209` | **3.4 / 7.0 / 54.1** | **0** | 1,299 | 88,691 | 0.6 | 0.20 |
| `e9-edge-…181313` | **3.7 / 7.0 / 34.2** | **0** | 1,297 | 88,704 | 1.0 | 0.23 |

- **3 of 4 runs:** shoppers as fast as with **no attacker at all** (p95 7.0–7.2 ms vs 9.8 ms). The attacker got
  1,297–1,299 searches: the API's own per-user limit. NGINX refused the rest in ~0.6–1 ms each.
- The API's event loop was 20–26% busy, down from 100%.
- **The bad run (first after an API restart):** in three short windows the API container was CPU-throttled for ~1 s per
  second, event-loop lag p99 reached **2.4 s**, and MySQL connections timed out (`connect ETIMEDOUT`), while the API used
  only 0.36–0.45 CPU. No sleep events in the Windows log. Not reproduced in the next 3 runs, and the cause is not
  proven: this laptop's Docker VM stalls (E3e) are the suspect.
- **The backup bucket was used only in that run:** ~1,300 decisions in its window (Prometheus), 0 in runs 2–4. It did
  its job: attacker searches served fell to 804, where fail open had let 7–10 thousand through.

---

## Correctness tests (real HTTP + Redis, both adapters)

`test/rate-limit.e2e-spec.ts`, **20 tests** (10 × Fastify, Express):
- a burst of 5 then 429 + `Retry-After`; refill at the rate; a long quiet period still caps at the capacity
- 50 parallel requests against 10 tokens → **exactly 10** get through (atomic Lua)
- two API instances share one bucket
- per user even from one IP, also on public pages
- checkout's own smaller bucket; login limited per IP whatever the email
- health, metrics and webhooks never limited
- `X-Real-IP` trusted only with `TRUST_PROXY=true`

Unit (`rate-limit.guard.spec.ts`): local backup bucket (refill, cap, wait time), guard falls back to it, key choice,
settings parsing.

**Mutation checks:**
- counting by IP only → 1 failed
- always trusting `X-Real-IP` → 1 failed
- no capacity cap in the Lua → 1 failed
- the public-route fix removed → 1 failed
- "Redis late → allow" put back → 1 failed

All were restored, and the tests pass again.

## Not measured (yet)

- **Many attacker IPs or tokens.** The edge key is the token; random fake tokens get a fresh NGINX bucket each (the API
  then counts them by IP). Floods without a token are limited only by the API, per IP. Real deployments add a per-IP
  limit at the CDN/WAF; one laptop with one source IP can't test that fairly.
- **More than one API replica** with the edge limit.
- **Redis really down** (only "Redis too slow" happened, in the bad run).
