# E10 — Two-factor login (authenticator app / TOTP)

**Date:** 2026-11-16 · **Phase:** 6b · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop |
| API | 1 replica, 1 CPU, Fastify · MySQL 8.4.13 · NGINX in front (all calls go through it) |
| Script | `apps/api/scripts/e10-two-factor.ts` (plain `node`), run twice: `node scripts/e10-two-factor.ts http://localhost:8088 180 30 35` |
| Limits | `RATE_LIMIT_AUTH=1000:100` for the runs (the script registers ~62 users from one IP); `TWO_FACTOR_MAX_FAILURES=5`, `TWO_FACTOR_LOCK_SECONDS=900` (defaults) |
| Raw data | `load-tests/results/e10-two-factor-*.log` |

**How it works:**
- The phone and the server share a random 160-bit secret, shown once as a QR code.
- Both compute `code = HMAC-SHA1(secret, floor(time / 30 s))` → 6 digits. They never talk to each other.
- The server accepts the code for the current 30 s step and one step either side (clock drift), and never a step that
  was already used (replay).

---

## E10a — Is the server's clock good enough? (TOTP depends on it)

This laptop's Docker VM clock is known to drift and be stepped back (E5 gotcha). The script read the API's clock
(`serverTime` of `GET /drops/:id`, ms precision) every 2 s for 180 s and compared it with the middle of each request.

| Run | Samples | Offset API − laptop | Jumps > 100 ms | Request round trip (max) |
|---|---|---|---|---|
| 1 | 90 | −214 … +112 ms | 2 (+210 ms, +102 ms) | 59 ms |
| 2 | 90 | −80 … +71 ms | 0 | 57 ms |

- The worst offset (0.2 s) is **~140× smaller** than the tolerance: one 30 s step either side.
- The offset includes up to half a round trip of measuring error (≤ 30 ms).
- Not measured: a real phone's clock (phones sync via the network), or the VM after hours of sleep.

## E10b — What does the extra step cost?

30 users with 2FA and 30 without, logged in one after another through NGINX.

| | Run 1: p50 / p95 / max ms | Run 2: p50 / p95 / max ms |
|---|---|---|
| Login without 2FA (password → tokens) | 40.4 / 57.8 / 166.4 | 29.1 / 59.7 / 70.8 |
| 2FA step 1 (password → challenge) | 29.4 / 44.9 / 46.7 | 23.6 / 29.9 / 32.6 |
| 2FA step 2 (code → tokens) | 41.0 / 109.7 / 132.6 | 13.7 / 16.7 / 17.5 |

- **Step 1** costs about the same as a normal login: both are mostly Argon2 (the password hash, deliberately slow).
- **Step 2** does no Argon2: a JWT check, an HMAC and three small MySQL writes (reserve an attempt, mark the step used,
  store the refresh token). It took 13.7 ms p50 in run 2 but 41 ms in run 1. Each write is a commit, and commits on this
  laptop's Docker disk vary (E3e). Not tuned: the writes could share one transaction.
- **For the user, the real cost is human:** opening the app and typing 6 digits takes seconds, not milliseconds.

## E10c — Can someone with the password guess the code?

| Test (fresh user each, real stack) | Run 1 | Run 2 |
|---|---|---|
| 8 wrong codes one by one | 401 ×5, then 429 ×3 | same |
| then the **right** code | **429 `two_factor_locked`**, retry after 900 s | same |
| 30 wrong codes **at the same moment** | **5 × 401, 25 × 429** | same |

- Each check first *reserves* an attempt: `UPDATE … SET failed_codes = failed_codes + 1 WHERE failed_codes < 5 AND not
  locked`, so only 5 parallel guesses can get a slot.
- **Mutation check:** with the naive version ("read the counter, then add 1"), **all 30 of 30** parallel guesses were
  checked (test failed). Back to the atomic version → 5.
- **The odds:** one guess hits 3 of 1,000,000 codes, so 3 in a million. 5 guesses per 15 min = 480 per day → about
  **0.14% per day** for an attacker who already has the password. Lowering it further means longer or escalating
  locks, alerting the user, or a CAPTCHA (not built).
- The counter is in MySQL, not Redis: Redis fails open (E9), and a 6-digit code must never get unlimited guesses.

## A bug the web tests found (and why the API answers 400, not 401)

- **Symptom:** the shop's API client treats every 401 as "access token expired". It refreshes the tokens and sends
  the request again.
- **Effect:** with 401 for a wrong code on "turn on / turn off", every wrong code was sent **twice**: it used **2 of the
  5 attempts** and rotated the user's tokens. In the web test (no refresh route) the user was logged out instead.
- **Fix:** a signed-in user's wrong code → **400** `invalid_code`. Login step 2 keeps 401, because the caller isn't
  signed in yet.

---

## Correctness tests

- **Unit (`totp.spec.ts`, 6):** RFC 6238 test vectors (all 6 times, 8 and 6 digits), base32 (RFC 4648 vectors),
  window ±1 and not ±2, replay refused, non-6-digit input refused, the otpauth:// link.
- **e2e (`two-factor.e2e-spec.ts`, 20 = 10 × Fastify/Express, real MySQL):**
  - setup → enable → 10 backup codes
  - the secret is stored encrypted, never as the shown base32
  - a challenge is not an access token
  - replay; lock after 5, even for the right code; 30 parallel → exactly 5 checked
  - backup code once; forged challenge; disable needs a code; new backup codes replace old ones
- **Web (4):** login asks for the code and stores no tokens before it; wrong code keeps asking; Security page: QR (SVG)
  + key → code → 10 backup codes; wrong first code shows the error.
- **Mutation checks:** never lock → 1 failed · no replay check (both layers) → 1 failed · backup code reusable →
  1 failed · challenge without its own audience → 4 failed · naive read-then-update counter → 1 failed (30 of 30
  checked). All restored.

## Not built / not measured

- **Sessions that existed before 2FA was turned on stay valid.** Their refresh tokens aren't revoked; a stolen session
  survives enabling 2FA.
- **"Remember this device", WebAuthn/passkeys, SMS or email codes.**
- **Making 2FA mandatory** (e.g. for admins).
- **Email alerts** on enable/disable or on a lockout.
- **Secret key rotation:** the encryption key derives from `JWT_SECRET` unless `TOTP_ENCRYPTION_KEY` is set. Rotating
  it needs a re-encrypt step that doesn't exist.
