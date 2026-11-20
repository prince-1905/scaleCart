# E12 — An API gateway (Kong): what it costs, what it keeps away from the shop, and what happens when it stops

**Date:** 2026-11-18 · **Phase:** 9 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop |
| Path | Browser → **NGINX** (edge: shop files, flood limit per token, client IP) → **Kong 3.9.4** (DB-less, 2 workers, 1 CPU, 512 MB) → shop API (1 replica, 1 CPU) / payments |
| Kong does | Checks tokens on protected routes (`jwt`: HS256, issuer `scalecart`, expiry), routes to shop or payments, refuses `/internal/*` and `/metrics` (404), adds `X-Request-ID`, exports metrics |
| Lab bypass | `lb-direct` (compose profile `lab`, port 8090): the same NGINX edge, straight to the shop, no Kong. Only for this experiment |
| Load | `load-tests/e12-gateway.js` (k6, open model, 60 s): logged-in shoppers + an "attacker" sending **a different forged token on every request** |
| Operations | `load-tests/e12-gateway-ops.mjs`: 100 product-page requests/s (10 logged-in users) + 1/s for the shop's start page, while the gateway is stopped, restarted or reloaded |
| Login bucket | `RATE_LIMIT_AUTH=1000:100` during the k6 runs (setup logs in 50 users from one IP; default is 10:0.2), restored afterwards |
| Raw data | `load-tests/results/e12-*` (`e12-summary.md` = all k6 runs in one table, `e12-runs-index.txt` maps labels to runs) |
| CPU | `docker stats` every ~2 s during each run, in % of one core: the **average** over the run. Peaks in every run are the setup's 50 Argon2 logins |

---

## E12-0 — Checking the rules first (and two surprises)

`infra/kong/check-gateway.mjs`: 16 checks against the live stack, all passing. Examples: no token / forged signature /
expired / unknown issuer on `/cart` → **401 from Kong**; a valid token → 200 from the shop; right secret but wrong
audience (like the 2FA challenge token) → passes Kong, **refused by the shop** (defense in depth); `/internal/*` → 404
at Kong even with a token and a guessed service token.

Mutation-checked:
- **Expiry off** (`claims_to_verify: []`) → the "expired token" check failed. The expired token still got a 401, but
  from the shop: the shop's own check is the second wall.
- **`/internal` not blocked** → that check failed (the shop answered "missing or wrong service token").

**Surprise 1:** Kong's `jwt` plugin does **not** check expiry unless you list `exp` in `claims_to_verify`. Without it,
an expired token would pass the gateway.

**Surprise 2:** the first trial runs had 14–19 shopper 401s: "Bad token; invalid JSON". Not Kong's fault. Seed users
`loadtest+10` and `+11` have 2FA on (since E10), so their login returns a 2FA challenge, not a token, and the script
sent `Bearer undefined`. The script now skips users without a token.

## E12a — The cost of the extra hop

300 product-page requests/s (logged in, cached in Redis), 60 s, alternating with and without Kong, 3 runs each:

| | p50 | p95 | p99 | Kong's own time (X-Kong-Proxy-Latency) p50 / p95 | Kong CPU (avg) |
|---|---|---|---|---|---|
| **Through Kong** | 2.4–3.9 ms | 13.1–51.9 ms | 49.5–487 ms | **0 / 1 ms** | 13.5–19.1% |
| **Without Kong** | 2.0–2.7 ms | 9.9–16.8 ms (one run: 1,352) | 40.4–69.6 ms (one run: 4,537) | – | – |

- At the median the gateway adds **~0.1–1.2 ms**. Kong's own processing rounds to 0–1 ms; the rest is one more network
  hop inside Docker.
- The tails are laptop noise in both directions: one run without Kong had a multi-second stall (p95 1.35 s), and the
  first Kong run had host CPU above 85%. Don't read the p95/p99 columns as a gateway effect.
- 300 req/s cost Kong 13.5–19.1% of one core.

## E12b — A flood of forged tokens, with and without the gateway

50 logged-in shoppers (50 req/s: product page, search, cart) + an attacker at **1,000 req/s**, each with a new forged
token. A new token per request slips past NGINX's per-token limit, and the shop's own rate limiter never sees these
requests: the token check comes before the limiter.

| | Shoppers p50 / p95 / p99 | Shopper errors | Shop CPU avg | Shop event loop busy (max) | Kong CPU avg | 60,000 forged requests refused by |
|---|---|---|---|---|---|---|
| **Flood through Kong** (×3) | 3.2–3.7 / **9.4–16.3** / **26.7–51.3 ms** | 0 | **15.2–16.0%** | 0.12–0.22 | 31.6–34.3% | **Kong**, p50 1.1 ms |
| **Flood without Kong** (×3) | 2.6–3.4 / **22.6–36.3** / **99.2–145.1 ms** | 0 | **49.6–52.1%** | 0.52–0.55 | – | **the shop**, p50 1.0–1.5 ms |
| No attack, through Kong (×2) | 4.4–4.5 / 10.7–11.5 / 17.2–19.4 ms | 0 | 14.4–16.2% | 0.14–0.25 | 5.5–5.9% | – |
| No attack, without Kong (×2) | 4.3–5.4 / 13.1–14.8 / 20.1–26.1 ms | 0 | 16.5–16.8% | 0.13–0.25 | – | – |

- **With Kong, the shop didn't notice the attack:** its CPU stayed at the no-attack level (15–16% vs 14–17%), and its
  event loop was as idle as in the calm runs.
- **Without Kong, the shop spent ~3× the CPU** saying "401" to fake tokens, and shoppers' p95 went up ~2× (p99 ~3×).
- Nobody got in either way: the shop checks signatures too. The gateway's win is **where** the work happens. Kong
  paid ~26–29 points of one core for it, separate from the shop.
- At 1,000 req/s the shop still coped. The difference would grow with a bigger flood, or with a slower shop.

## E12c — The gateway down for 30 s

100 product-page requests/s + 1/s for the shop's start page. `docker compose stop gateway`, wait 30 s, `start`.

| | Run 1 | Run 2 | Run 3 (after the fix) | Run 4 (after the fix) |
|---|---|---|---|---|
| Product pages while stopped | 0 of 3,187 ok | 0 of 3,159 ok | 0 of 3,152 ok | 0 of 3,089 ok |
| …what customers got | 504 after 2 s, 1 × 502 | 1,100 × 504, 2,059 × 502 | 3,040 × 504, 112 × 502 | 2,975 × 504, 114 × 502 |
| Shop start page `/shop/` (NGINX itself) | 31 of 31 ok | 31 of 31 ok | 31 of 31 ok | 30 of 30 ok |
| Kong ready (log) after the start command | 18.6 s | 6.1 s | 5.9 s | not captured |
| **Product pages served again** after the start command | **18.6 s** | **19.5 s** | **5.9 s** | **6.0 s** |

- **The bug (runs 1–2):** in run 2 Kong was ready after 6.1 s, but NGINX answered "no live upstreams" (502) for
  another **13 s**. NGINX's passive health check (`max_fails=1 fail_timeout=10s` by default) had marked the only
  gateway as down while it was starting, and kept refusing after it came back.
- **The fix:** `server gateway:8000 resolve max_fails=0;`. With one server, marking it "down" never helps. After the
  fix, the first page was served **~0.2 s** after Kong was ready (run 3).
- **What customers see:** the shop's pages still load (NGINX serves them), but every API call fails: no products, no
  cart, no checkout. A single gateway is a **single point of failure**.
- Kong's own boot took 5.9–18.6 s here (DB-less: builds all routes and plugins at start).
- The trade-off of `max_fails=0`: while the gateway is down, NGINX keeps trying the old address, so most customers wait
  2 s for a 504 instead of getting a 502 at once.
- Not counted: a first run with a script bug (it picked tokens by counting answers; during the outage one token got all
  the traffic and hit NGINX's limit, 429s). Fixed before runs 1–4.

## E12d — Restarting vs reloading the config, under traffic

Same traffic (100 req/s + the start page).

| | Run 1 | Run 2 |
|---|---|---|
| `docker compose restart gateway` | **389** of 1,113 failed (502), for **3.9 s** | **453** of 1,141 failed (502), for **4.5 s** |
| Config changed through Kong's admin API (DB-less `POST /config`), twice per run | **0** of 2,069 failed; applied in 196 / 28 ms | **0** of 2,044 failed; applied in 26 / 20 ms |

- A config change (here, the shop's read timeout) **doesn't need a restart**: Kong swaps the whole config atomically
  while serving. 0 failures in ~4,100 requests across both runs.
- A restart of the only gateway costs ~4 s of errors. Fixing that needs **two gateways** behind NGINX and restarting
  them one at a time. Not built or measured yet.
- Our compose setup builds the config at start, so a config change in the repo still needs a restart today. The admin
  API (`infra/kong/reload.lua`, inside the container only) is how you'd change it live.

---

## Tests

All passing on 2026-11-18: shop 68 unit, 180 end-to-end; payments 16 unit, 25 end-to-end; gateway checks 16 of 16.
The first full shop run had 1 failure in a Phase 8 test ("payment.captured → paid, stock committed"). It passed 3 of 3
on its own. I didn't keep the error message; the likely cause is a race in the test: the stock is committed right after
the "paid" transaction, and the test checked it the moment the status turned "paid". The test now waits for it too, and
the full suite passed (180 of 180).
- New: `apps/api/src/observability/logger.spec.ts` (the request id), a payments e2e test that Pay forwards
  `X-Request-ID` to the shop (mutation-checked: removing the header makes it fail).
- `infra/kong/check-gateway.mjs`: 16 checks against the running stack (mutation-checked twice, see E12-0).
