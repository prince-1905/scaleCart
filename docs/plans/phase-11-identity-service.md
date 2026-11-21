# Plan — Phase 11: split identity (login, users, 2FA) into its own service

Decided with the owner (2026-11-20): the next service to split out is **identity**, as `apps/identity` (own
package.json, Dockerfile, image, container, MySQL user `identity` on `scalecart_identity`). Branch
`phase-11-identity-service` from `main` after PR #17 (tracing) is merged.

## Why identity (the reasons we'll measure)

1. **It scales differently.** Logging in runs Argon2 on purpose (slow, ~50 ms of CPU per attempt). A login rush (the
   minutes before a drop) competes for the same CPU as browsing and checkout today. As its own service it gets its
   own CPU, and can scale on its own.
2. **A security fix: only identity can create tokens.** Today one HS256 secret (`JWT_SECRET`) is shared by the shop,
   payments and Kong. Whoever holds it can *mint* a token for any user, so a leak from any of them is a full takeover.
   After the split identity signs with a **private key (RS256)**; everyone else gets only the **public key**, which can
   check a token but never create one. Keys have ids (`kid`), so a new key can be added without logging everyone out.
3. **A clean border.** The rest of the shop only asks identity one thing: "what's this user's email?" (confirmation
   emails, the admin order list and order page).

## After the split

```
Browser ──► NGINX ──► Kong ── /auth/*                                  ──► identity  (register, login, 2FA, refresh,
                        │                                                             logout, me; Argon2; Redis throttle)
                        ├── everything else, as today                  ──► shop / payments
                        └── jwt plugin: RS256 with identity's PUBLIC key (by kid)

identity  GET /.well-known/jwks.json      public keys (anyone may read)
          GET /internal/users?ids=…       emails, service token only (Kong blocks /internal/*)
shop / payments: verify tokens with the public keys from JWKS (cached, refreshed on an unknown kid)
shop worker: confirmation email → asks identity for the address (timeout, retry, circuit breaker; the queue retries
             if identity is down, the email is late, never lost)
```

| Data / decision | Owner |
|---|---|
| Users, passwords, refresh tokens, 2FA secrets and backup codes, login throttling, **signing keys** | **identity** |
| Everything else | as today (shop, payments) |

## Steps

| Step | What |
|---|---|
| 11a | `apps/identity` skeleton (copy of the payments service's structure: env, health, metrics, tracing, logger, graceful drain) |
| 11b | Move identity's code, migrations and tests (auth, refresh rotation, 2FA, login throttle) from the shop |
| 11c | RS256 signing with a key id; `/.well-known/jwks.json`; keys from `.env` (`IDENTITY_JWT_PRIVATE_KEY`, only identity gets it) |
| 11d | Shop + payments: verify RS256 via JWKS (cache by kid); the shared HS256 `JWT_SECRET` stays only for what isn't a login token (drop passes, 2FA secret encryption) |
| 11e | Shop: `UserDirectory` becomes an HTTP client to identity (`/internal/users`), with timeout, retry and breaker |
| 11f | Kong: `/auth/*` → identity; jwt plugin switched to RS256 with the public key per kid |
| 11g | Shop tests: tokens minted with a test key + a fake identity for emails, instead of registering through the shop |
| 11h | Infra: MySQL user `identity`, compose service + migrate job, seed (users) moved, Prometheus job |
| 11i | **E14** (below) and docs |

## Setting it up on an existing MySQL volume

The init script (`infra/mysql/init/03-identity-user.sh`) only runs when the MySQL volume is first created. On an
existing one, create the login once (root password from `.env`):

```sql
CREATE USER IF NOT EXISTS 'identity'@'%' IDENTIFIED BY '<IDENTITY_DB_PASSWORD from .env>';
GRANT ALL PRIVILEGES ON scalecart_identity.* TO 'identity'@'%';
```

The tables already exist (the shop created them); identity's migrate job finds its migrations applied ("0 applied").
Existing users, refresh tokens and 2FA secrets keep working (same database, same 2FA key derivation). Access tokens
issued before the switch (HS256) are refused. The web client refreshes on a 401, and refresh tokens still work
(identity e2e tests), so a signed-in browser should get a new RS256 token by itself: not tried in a real browser.

## E14 — what we will measure

1. **Login rush vs shoppers:** many logins per second (Argon2) next to normal shoppers, before (logins in the shop) and
   after (logins in identity): shoppers' p95, shop CPU.
2. **Identity down:** signed-in shoppers keep shopping (tokens are checked with the public key, no call to identity);
   new logins fail; confirmation emails wait in the queue and go out when identity is back.
3. **RS256 vs HS256:** the cost of checking a token (Kong and Node), since RS256 is slower to verify.
4. **Key rotation:** add a second key under load: old tokens still accepted, new ones signed with the new key, 0 errors.
