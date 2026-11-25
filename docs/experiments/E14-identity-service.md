# E14 — Identity as its own service: login rushes, outages, RS256 and key rotation

**Date:** 2026-11-20 · **Phase:** 11 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop. Every load run was checked against the Windows power log (event 105, the charger kept reconnecting that day); none of the runs below had one inside it |
| After the split | NGINX → Kong → **identity** (`apps/identity`: register, login + 2FA, refresh, users; Argon2id; 1 CPU) / shop (1 CPU) / payments. Identity alone signs access tokens: **RS256**, key id in the header. Kong, the shop and payments get only the public keys (Kong from `.env`, the services from `/.well-known/jwks.json`) |
| Before (for E14a) | `main` (Phase 10): logins inside the shop (1 CPU), HS256 tokens with the shared `JWT_SECRET`. Run from a second checkout of `main` against the same database |
| Load | `load-tests/e14-login-rush.js` (k6, 60 s): 50 logged-in shoppers at 50 req/s (product page, search, cart) + LOGIN_RATE successful logins/s (seed users 100–1999). Login rate limit lifted for the runs (`RATE_LIMIT_AUTH=100000:100000`: all traffic comes from one IP) |
| Operations | `load-tests/e12-gateway-ops.mjs identity \| rotate \| recreate`: 100 `/cart` requests/s (needs a token check) from 10 users while identity is stopped, restarted or its key rotated |
| Raw data | `load-tests/results/e14-*` (`e14-before-summary.md`, `e14-after-summary.md`, `e14-halfhalf-summary.md`, `e14-identity-down-*.txt`, `e14-rotate-*.txt`, `e14-recreate-*.txt`, `e14-token-bench.txt`) |

---

## E14a — A login rush next to shoppers, before and after the split

Each login runs Argon2id (slow on purpose). Shoppers' latency and errors, 2 runs per row:

| Setup | Logins/s | Shoppers p50 | Shoppers p95 | Shoppers p99 | Shopper errors | Logins completed (of 60 s × rate) | Login p50 | CPU (avg) |
|---|---|---|---|---|---|---|---|---|
| **Before**: logins in the shop (1 CPU) | 0 | 7.4–8.3 ms | 13–24 ms | 83–232 ms | 0 | – | – | shop 27–34% |
| | **15** | **681–845 ms** | **5.9–7.2 s** | 10.0 s (timeout) | **29–73** | 732–773 of 900 | 11.0–14.7 s | shop **98%** |
| | **30** | **2.9–8.8 s** | 10.0 s | 10.0 s | **1,234–1,320** | 234–436 of 1,800 | 28–29 s | shop **96–101%** |
| **After**: identity 1 CPU + shop 1 CPU | 0 | 4.6 ms | 10 ms | 31 ms | 0 | – | – | shop 18%, identity 6% |
| | **15** | **4.7–5.0 ms** | **13.7–15.0 ms** | 29–40 ms | **0** | 900–901 of 900 | **43–59 ms** | shop 18–19%, identity 56–63% |
| | **30** | **6.1 ms** | **22.5–27.1 ms** | 46–65 ms | **0** | 1,431–1,446 of 1,800 | 15.5–16.8 s | shop 17%, identity **100%** |
| **Same total CPU**: identity 0.5 + shop 0.5 | 0 | 7.2 ms | 99 ms | 583 ms | 0 | – | – | shop 21%, identity 9% |
| | 15 | 9.2–9.8 ms | 176–203 ms | 0.7–1.1 s | **0** | 316–378 of 900 | 27–30 s | shop 20–22%, identity **50%** (its limit) |
| | 30 | 9.1–10.0 ms | 110–361 ms | 0.9–1.0 s | **0** | 234–248 of 1,800 | ~30 s | shop 21%, identity 50% |

CPU is `docker stats`, % of one core. Not counted: one "after" run with no rush (the Docker VM froze for ~7 s: 156
timeouts, the sampler skipped 7 s and then read 179%), and one "same CPU" run whose setup logins found identity still
busy with the previous run's queued logins.

- **Before, a login rush took the shop down for everyone.** At 15 logins/s the shop's one core was full of Argon2: the
  median shopper waited 0.7–0.8 s, p95 6–7 s, and 29–73 requests timed out. At 30/s, 40%+ of shopper requests failed.
- **After, shoppers didn't notice 15 logins/s** (p95 14–15 ms vs 10 ms) and still had 0 errors at 30/s. The shop's CPU
  stayed at 17–19%; the rush landed on identity.
- **Logins still have a limit, now their own:** at 30/s identity's core was full and logins queued (p50 16 s). The fix
  for that is more identity instances, which now doesn't mean more shop instances.
- **With the same total CPU (0.5 + 0.5) shoppers stayed error-free** (p95 0.1–0.4 s, vs 6–7 s before), so isolation,
  not just extra CPU, is what protected them. The price: logins could no longer borrow the shop's half and queued
  (p50 27–30 s, 34–56% timed out).
- Half a core is tight for the shop even without a rush (p95 99 ms vs 10 ms with a full core): CPU quotas throttle in
  bursts.

## E14b — Identity down for 60 s

`docker compose stop identity`, 60 s, `start`. Traffic: 100 `/cart` requests/s (every one needs a token check), logins
tried every 5 s, one order placed during the outage.

| | Run 1 | Run 2 | Run 3 (after the fix) | Run 4 (after the fix) |
|---|---|---|---|---|
| `/cart` while identity was down | 6,354 of 6,496 ok | **6,228 of 6,228** | **6,038 of 6,038** | **6,591 of 6,591** |
| Logins while down | 504 after 2.0 s | 504 after 2.0 s, or no answer in 5 s | 504 after 2.0 s | 504 after 2.0 s |
| First successful login after the start command | 15.9 s | 11.0 s | 15.0 s | 12.1 s |
| **Confirmation email of the order placed during the outage** | **never: dead-letter queue** | **never: dead-letter queue** | **0.29 s** after the order | **0.06 s** after the order |

- **Signed-in shoppers kept shopping:** tokens are checked with the public keys the shop already holds, no call to
  identity per request. (Run 1's 142 failures got no answer at all and never reached NGINX, which logged nothing at
  those moments: the Windows → Docker port forwarding, as in E13d.)
- **The bug the outage found:** the confirmation email asks identity for the customer's address. The email consumer
  gets 12 tries, 5 s apart (~60 s). Identity was down longer than that, so both emails went to the dead-letter queue:
  the customers never got them.
- **The fix: carry the data in the event** ("event-carried state transfer"). Identity puts the user's email into the
  access token; checkout copies it into `order.created`; the consumer uses it and asks identity only for older events
  without it. Runs 3–4: the emails went out within 0.3 s, during the outage; the dead-letter queue didn't grow.
- New logins need identity: during the outage Kong answered 504 (connect timeout to the stopped container), then 502
  while it booted (~11–16 s).
- The two dead-lettered emails (orders 01a1fa0e…, 01a1fa12…, test orders from runs 1–2) are still in
  `notifications.order-created.dlq`.

## E14c — RS256 vs HS256: the cost per token

`apps/api/scripts/e14-token-bench.ts`, one Node thread, the library the services use, best of 3 rounds, 3 runs:

| | HS256 (before, shared secret) | RS256 (now, private/public key) |
|---|---|---|
| Sign (once per login, in identity) | 89–95 µs | **2,571–2,703 µs** |
| Check (every request: Kong, shop, payments) | 113–124 µs | **154–167 µs** |
| Token length (sent with every request) | 265 characters | 579 characters |

- Checking costs ~40 µs more per request; signing ~2.6 ms more per login, still small next to Argon2 (~50 ms).
- What it buys: Kong, the shop and payments can no longer *create* a login. Checked live
  (`infra/kong/check-gateway.mjs`): a token made with the old shared secret now gets 401 at the gateway, and payments
  doesn't even have that secret any more.

## E14d — Rotating the signing key under traffic

`rotate`: (1) a new key into `.env`, the old public key still accepted; (2) Kong hot-reloaded with both public keys
(re-render + admin API, no restart); (3) 30 s later identity restarted with the new key; (4) new logins (new key id)
mixed into the traffic, 5 users with old tokens and 5 with new ones.

| Phase | Run 3 | Run 4 |
|---|---|---|
| Before | 1,001 of 1,001 ok | 1,001 of 1,001 ok |
| New key + Kong reload (applied in 31 / 30 ms) | 3,074 of 3,074 | 3,049 of 3,049 |
| Identity restarting with the new key | 1,363 of 1,363 | 1,371 of 1,371 |
| Old and new tokens together | **2,023 of 2,023** | **2,022 of 2,022** |
| After | 1,000 of 1,000 | 1,000 of 1,000 |

- **0 failed requests** in both runs. Old tokens kept working; the first token with the new key id worked at Kong (it
  already had the key) and at the shop (it fetched the key set the first time it saw the unknown kid).
- Logins were unavailable while identity restarted (first login 13.6–13.7 s after the restart began).
- Finally `--prune` dropped the old keys (after their tokens had expired), and Kong and identity were recreated.
- Runs 1–2 used a flawed design (one user's new token sent ~50 req/s, over the per-user limit of 20/s: 429s) and are
  not counted. They had no 401s either.

**The "slow window" was my test script (found 2026-11-21, during E15f).** Runs 3–4 showed `/cart` at p50 1.27–1.34 s
for ~13 s while identity restarted. Cause: `e12-gateway-ops.mjs` ran `docker compose up -d identity` with a *blocking*
`execSync`. Node's event loop stopped, so the traffic generator sent nothing for those ~13 s, then fired every
"missed" request at once. That burst was the slow window, and the trace matched it: time spent before the shop read the
request. The script now runs shell commands without blocking (`exec`). Reruns with the fixed script:

| Phase | Run 5 (fixed script) | Run 6 (fixed script) | Control: recreate identity + its deps (fixed script) |
|---|---|---|---|
| Before | 1,001 of 1,001 | 1,001 of 1,001 | 1,001 of 1,001 |
| New key + Kong reload | 3,125 of 3,125 | 3,149 of 3,149 | – |
| Identity restarting | **1,559 of 2,529** (970 failed: 501 no answer within 5 s, 469 × 500) | **1,229 of 1,229**, p50 5.3 ms, max 46 ms | 2,825 of 2,825, p50 6.0 ms |
| Old and new tokens | 2,030 of 2,030 | 2,032 of 2,032 | – |
| After | 1,000 of 1,000 | 1,001 of 1,001 | 1,000 of 1,000 |

- With the fixed script the restart phase is **not slow** (p50 5.3–7.3 ms). Run 6 is clean.
- **Run 5 had 970 failures** in a 10 s window (sent 42.8–52.5 s into the run), and identity took 25.3 s to give its
  first login (12.3–13.7 s in the other runs). No power event in the System log at that time. Run 6 repeated the same
  flow with 0 failures, so this was seen once and is **not explained**. Kong's logs from run 5 were lost (the gateway
  was recreated right after, for the prune).
- Same artifact, smaller, in E12's restart/reload timings: those were measured with the same blocking script.

---

## Tests

Passing on 2026-11-21: identity 16 unit, 26 end-to-end; shop 69 unit, 140 end-to-end; payments 16 unit, 29
end-to-end; gateway checks 22 of 22; tracing check passes.
- Two flaky things in full shop runs, both now understood: (1) the new "older event" email test failed when another test
  process's worker took its message (they share the test queue, each process has its own fake identity): fake
  identities now all derive the same address from the user id, and the test no longer counts calls on its own fake;
  (2) two rate-limit timing tests failed once in a full run on a busy laptop and passed 3 of 3 alone (refill timing,
  as in E11). The final full run passed 140 of 140.
- Moved to identity with the code: registration, login, refresh rotation, 2FA (incl. 30 parallel guesses), login
  throttling, the per-IP login limit. New: RS256 + kid, the JWKS (no private parts), a token signed with another key,
  the internal email lookup, key rotation (old key accepted while listed, refused after it's dropped), the email claim.
- Shop and payments tests use a fake identity (its own RSA key, JWKS, email lookup). New: payments refuses HS256,
  unknown kid, expired and wrong-audience tokens; the confirmation email goes out while identity is down.
- Mutation-checked: payments reading tokens without checking the signature (3 tests failed); identity ignoring its
  older keys (rotation test failed); the email consumer ignoring the address in the event (the identity-down test
  failed).
