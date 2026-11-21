# Interview notes — Phase 11: Identity as its own service (and RS256 tokens)

Evidence: [E14 experiment report](../experiments/E14-identity-service.md). Plan: [phase-11 plan](../plans/phase-11-identity-service.md).
Code: `apps/identity/`, `apps/api/src/identity/` (what's left: the guard, `JwksKeys`, `UserDirectory`),
`apps/payments/src/common/`, `infra/kong/` (`render.sh`, `kong.template.yml`), `infra/identity/new-signing-key.mjs`.

---

## 1. The 30-second version

> "I split login and users out of the shop into an identity service, for two reasons I could measure. First, logins
> are CPU-heavy on purpose (Argon2). Before the split, 15 logins a second filled the shop's CPU and shoppers' p95 went
> to 6–7 seconds with timeouts. After the split, the same rush didn't touch shoppers (p95 14 ms, 0 errors), even with
> the same total CPU. Second, security: every service used to share one HS256 secret, so a leak anywhere meant anyone
> could mint an admin token. Now only identity holds a private RSA key; the gateway and services only have the public
> key, which can check a token but never create one. The outage test found a real bug: confirmation emails depended
> on identity and got dead-lettered during a minute-long outage. I fixed it by carrying the email in the event."

---

## 2. The user's view

| I am… | What happens now | Measured |
|---|---|---|
| A shopper during a login rush (15/s) | Nothing changes for me | p95 14–15 ms (no rush: 10 ms). Before the split: p95 6–7 s, timeouts |
| Someone logging in during that rush | My login takes ~50 ms | Before: 11–15 s |
| A signed-in shopper while identity is down | I keep shopping: my token is checked with a public key the shop already has | 6,228 of 6,228 cart requests ok |
| Someone trying to log in while identity is down | "Service unavailable" until it's back | 504 after 2 s; works again 11–16 s after restart |
| A customer who ordered during that outage | My confirmation email arrives anyway | 0.06–0.3 s after the order (before the fix: never) |
| An attacker who stole the shop's or payments' config | Can't forge a login: there's no signing key there | Old-secret token → 401 at the gateway |

---

## 3. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Identity service** | Owns users, passwords, sessions, 2FA, and issues tokens | The passport office |
| **HS256** | Token signed and checked with the SAME secret (symmetric) | Everyone with the stamp can make passports |
| **RS256** | Signed with a private key, checked with the public key (asymmetric) | Only the office has the stamp; border guards get a picture of it |
| **JWKS** | The public keys published as JSON (`/.well-known/jwks.json`) | The official list of genuine stamps |
| **kid (key id)** | Which key signed this token; lets several keys be valid at once | The stamp's serial number |
| **Key rotation** | Start signing with a new key, keep accepting the old one until its tokens expire, then drop it | Introducing a new stamp without voiding passports already issued |
| **Event-carried state transfer** | Put the data a consumer needs into the event, so it doesn't have to call back | The order slip already has the customer's address on it |
| **Bulkhead / isolation** | Separate resources so one overload can't sink everything | Watertight compartments in a ship |

---

## 4. How it fits together

```
Browser → NGINX → Kong ── /auth/* ─────────────► identity (Argon2, users, refresh tokens, 2FA; PRIVATE key)
                    │       /.well-known/jwks.json  (public keys, anyone may read)
                    │       /internal/users?ids=…   (emails, service token; Kong blocks /internal)
                    ├── checks every protected request with identity's PUBLIC keys (by kid)
                    └── everything else ─────────► shop / payments: check tokens again with the public keys (JWKS,
                                                    cached; refetched when an unknown kid shows up)
Checkout puts the customer's email (from the token) into order.created → the worker emails without asking identity.
```

---

## 5. The stories

### Story A — "A login rush used to take the shop down" ⭐
- **Before:** 15 logins/s next to 50 shopper req/s: shop CPU 98%, shoppers p50 0.7–0.8 s, p95 6–7 s, 29–73 timeouts.
  30/s: 41–44% of shopper requests failed.
- **After:** same rush, shoppers p95 14–15 ms, 0 errors; at 30/s still 0 errors (identity full, shop at 17% CPU).
- **Fair test:** with the same total CPU (0.5 + 0.5), shoppers still had 0 errors. Isolation, not extra CPU, saved them.
- **Trade-off:** logins can no longer borrow the shop's CPU: they queue sooner. Scale identity separately.

### Story B — "The outage test found a lost email" ⭐
- Identity down 60 s → signed-in shoppers fine, but the confirmation email of an order placed meanwhile went to the
  dead-letter queue: the worker had to ask identity for the address, and 12 tries × 5 s ran out.
- **Fix:** the email travels in the token and in the `order.created` event. After the fix the email went out within
  0.3 s during the outage. Lesson: each sync call between services is a way to fail; prefer carrying data in events.

### Story C — "Only one service can create a login" ⭐
- Before: one HS256 secret shared by the shop, payments and Kong. Leak anywhere = forge any token, even admin.
- After: RS256. Identity signs with its private key; the others fetch the public key. The gateway check proves a token
  made with the old secret now gets 401; payments no longer has any secret.
- Cost: checking ~154–167 µs instead of 113–124 µs per request, signing ~2.6 ms per login, tokens 579 vs 265 chars.

### Story D — "Changing the key without logging anyone out"
- Key ids (`kid`) let old and new keys be valid together. Rotation under traffic: new key → Kong hot-reloaded (30 ms)
  → identity restarted → 0 failed requests; old tokens worked, new ones too (the shop fetched the new key on first
  sight). Then the old keys were pruned.
- Honest open point: during identity's restart in those runs, cart requests slowed to p50 ~1.3 s for ~13 s (trace:
  time spent before the shop read the request). Not explained yet.

---

## 6. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| RS256 + JWKS | Only identity can mint tokens; keys can rotate | Slower checks (~40 µs), bigger tokens, key management |
| Verify locally (public key cached), no call per request | Shoppers unaffected by identity outages | A revoked user keeps a valid token up to 15 min |
| Email in the token and the event | Emails don't depend on identity being up | Personal data in a bearer token (the user's own); a changed address is stale until the next login |
| Kong gets keys from `.env`, services from JWKS | Kong starts without identity; services pick up new keys by themselves | Kong needs a re-render + reload on rotation |
| Same MySQL server, own database + login | Hard data wall, cheap on one laptop | MySQL down = everything down |
| Shop tests use a fake identity | Fast, no real logins needed | Contract drift possible (the gateway and tracing checks cover the real path) |

---

## 7. Likely questions

1. **Why RS256 over HS256?** With HS256 anyone who can verify can also sign. Spreading that secret across services and a
   gateway multiplies the places it can leak from. RS256 separates signing (private key, one place) from verifying
   (public key, everywhere).
2. **How do services get the public key?** From identity's JWKS endpoint, cached in memory; refreshed every 5 minutes
   and when a token with an unknown `kid` arrives (rate-limited, so made-up kids can't flood identity).
3. **What if identity is down?** Existing tokens keep working (no call per request). Logins fail. Anything that needed
   identity synchronously is a risk: we had one (emails) and removed it.
4. **How do you rotate keys?** Add the new key, keep the old public key listed, switch signing, wait for old tokens to
   expire (15 min), remove the old key. Measured: 0 failed requests.
5. **How do you revoke a token before it expires?** We don't, by design: short access tokens (15 min) + revocable
   refresh tokens. For instant revocation: a deny-list checked by the gateway, or very short tokens.
6. **Why not call identity on every request?** It would make every request depend on identity (latency, outages):
   exactly what the outage test showed for emails.
7. **Is this microservices now?** Three services (shop, payments, identity), each with its own database and login, plus
   a gateway. The shop is still a modular monolith inside, which is fine.

---

## 8. Self-quiz

1. Why could a leak of the shop's config forge an admin token before Phase 11, but not now?
2. What does `kid` do, and why does rotation need it?
3. Why did shoppers survive a login rush after the split, even with the same total CPU?
4. Why did a confirmation email get lost during the identity outage, and what fixed it?
5. What does RS256 cost compared to HS256?
6. Identity is down. Who notices?

<details><summary>Answers</summary>

1. Before, the shop held the HS256 secret, and the same secret both signs and verifies. Now it holds only the public
   key, which can't sign.
2. It names the key that signed the token, so verifiers pick the right public key, and two keys can be valid at once
   during a rotation.
3. Logins' Argon2 runs on identity's own CPU budget; it can't take the shop's (bulkhead). Shoppers had 0 errors at both
   15 and 30 logins/s.
4. The worker asked identity for the address; 12 retries over ~60 s ran out and it was dead-lettered. Carrying the
   email in the token → event removed the call.
5. Checking ~40 µs more per request (154–167 vs 113–124 µs), signing ~2.6 ms more per login, token 579 vs 265 chars.
6. People trying to log in or change 2FA, and admins (emails missing in the order list). Signed-in shoppers, checkout
   and confirmation emails don't.

</details>
