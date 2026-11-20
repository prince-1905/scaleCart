# Interview notes — Phase 9: An API gateway (Kong)

Evidence: [E12 experiment report](../experiments/E12-api-gateway.md). Plan: [phase-9 plan](../plans/phase-9-api-gateway.md).
Config: `infra/kong/kong.template.yml`, `infra/nginx/nginx.conf`, `docker-compose.yml` (service `gateway`).

---

## 1. The 30-second version

> "After splitting payments out, I put **Kong** in front as the API gateway: one front door that checks login tokens,
> routes each request to the shop or payments, blocks internal routes and stamps every request with an ID. I measured
> it. It adds about **1 ms** at the median. Under a flood of 1,000 requests a second, each with a **different forged
> token**, the shop's CPU stayed at its normal **15%** instead of **50%**, and shoppers' p95 stayed at 9–16 ms instead of
> 23–36 ms, because the fakes died at the gateway. The honest cost: it's a **single point of failure**. A restart
> gave ~4 s of errors, and I found an NGINX health-check default that kept customers out for 13 s after Kong was
> already back."

---

## 2. The customer's view

| I am… | What happens | Measured |
|---|---|---|
| A shopper browsing | One more hop (NGINX → Kong → shop) | +0.1–1.2 ms at the median; Kong's own time 0–1 ms |
| A shopper with an expired token | Kong says 401 at once; the app refreshes the token and retries | Refused at the gateway, the shop never sees it |
| An attacker sending fake tokens, a new one each time | Kong refuses every one | 60,000 of 60,000 refused at Kong (p50 1.1 ms); the shop's CPU didn't change |
| A shopper during that attack | Barely notices | p95 9–16 ms (no attack: 11 ms); without the gateway 23–36 ms |
| A shopper while the gateway is down | The shop page loads (NGINX), but no products, cart or checkout | Every API call fails (504 after 2 s or 502) |
| A shopper while we change a route or timeout | Nothing | 0 failures in ~4,100 requests during 4 live config changes |

---

## 3. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **API gateway** | One entry point for all services: auth, routing, limits, request IDs, metrics | Hotel reception: checks your ID, sends you to the right room |
| **Edge vs gateway** | Edge (NGINX/CDN): static files, TLS, floods. Gateway: API rules per route | The building's door vs the reception desk |
| **Offloading auth** | Check tokens once at the gateway, not separately in every service | One ID check at reception instead of at every room |
| **Defense in depth** | The services still check tokens (role, audience); the gateway is the first filter | Reception checks your ID, the room still needs your key card |
| **DB-less / declarative config** | Kong's whole config is one YAML file, no database | A printed rulebook instead of a filing cabinet |
| **Correlation / request ID** | One ID per request, passed to every service and logged | A ticket number that follows your order through every desk |
| **Single point of failure** | One component whose failure stops everything | One reception desk: if it closes, nobody gets in |
| **Passive health check** | The proxy marks a server "down" after failed requests | A receptionist who stops calling a room that didn't answer… for a while |

---

## 4. How a request flows now

```
Browser ──► NGINX :8088   /shop/*  → static files (works even if everything behind is down)
                          API      → flood limit per token (50/s) → Kong
            Kong :8000    /products, /drops, /inventory (GET), /auth/login…   → shop, no token needed
                          /orders/:id/payment, /payments/razorpay/confirm      → payments, token needed
                          /payments/razorpay/webhook, /callback                → payments, signature checked there
                          /internal/*, /metrics                                → 404
                          everything else                                      → shop, token needed
                          + X-Request-ID on every request (payments passes it on to the shop)
            shop / payments: still verify the token (audience, role)
```

---

## 5. The stories

### Story A — "Fake tokens die at the door" ⭐
- **Attack:** 1,000 req/s to `/cart`, each with a **new** forged token. NGINX's per-token limit can't catch it (every
  token is new), and the shop's own rate limiter never sees it (token check comes first).
- **Proof:** without Kong the shop's CPU averaged **50–52%**, with Kong **15–16%** (same as no attack). Shoppers' p95
  **9–16 ms vs 23–36 ms**, p99 **27–51 vs 99–145 ms**. Kong paid ~26–29% of a core.
- **Point:** the gateway doesn't make refusal free; it moves it to a separate, cheap tier that scales on its own.

### Story B — "The default health check kept customers out after Kong was back" ⭐
- **Symptom:** after restarting a stopped gateway, product pages came back after **18.6–19.5 s**. Kong's log said it
  was ready after 6.1 s.
- **Cause:** NGINX's passive health check (`max_fails=1`, `fail_timeout=10s`) marked the only gateway "down" while it
  booted, then answered "no live upstreams" for another **13 s**.
- **Fix:** `max_fails=0` for a single upstream. Pages came back **~0.2 s** after Kong was ready (5.9–6.0 s after start).
- **Lesson:** health checks help when there are several servers to choose from. With one server, they only add
  downtime.

### Story C — "Reload, don't restart"
- `docker compose restart gateway`: **389–453 failed requests** (~4 s).
- Changing the config through Kong's admin API: **0 failures** in ~4,100 requests, applied in 20–196 ms.
- **Next step:** two gateways and rolling restarts, so even upgrades cost nothing (not built yet).

### Story D — "Kong doesn't check expiry unless you ask"
- The `jwt` plugin checks the signature, but `exp` only if listed in `claims_to_verify`. I added it, and a test
  (mutation-checked) proves an expired token is refused at the gateway. The shop's own check caught it anyway: that's
  why services keep verifying.

### Story E — "One ID across services"
- Kong adds `X-Request-ID`; both apps use it as the log's request id; payments passes it on when it calls the shop. One
  ID finds every log line of a customer's Pay click in both services. This is the first step towards tracing.

---

## 6. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| Kong (open-source, DB-less) | Real, widely used gateway; config in one file, no DB | 541 MB image, ~6–19 s cold start; new features go to the enterprise image |
| NGINX kept as the edge | Serves the shop's files; its per-token flood limit already worked (E9) | Two proxies, two hops (~1 ms) |
| No rate limiting in Kong | Kong's open-source limiter counts fixed windows, and callers without a token fall back to per-IP: it would throttle anonymous browsing | Rate limits live in NGINX + the shop, not in one place |
| Services still verify tokens | A gateway misconfiguration must not open the shop | Each request's token is checked twice (~cheap) |
| Admin-only routes not checked by role at Kong | Roles are business rules; the shop owns them | A customer's admin request reaches the shop (403 there) |
| One gateway | Simple on one laptop | Single point of failure: down = no API; restart = ~4 s of errors |
| `max_fails=0` | Only one gateway: "down" marking only adds downtime | While it's really down, customers wait 2 s for a 504 instead of an instant 502 |

---

## 7. Likely questions

1. **What does an API gateway do that a load balancer doesn't?** A load balancer spreads traffic. A gateway applies API
   rules per route: authentication, routing to different services, request IDs, metrics, sometimes rate limits and
   request transforms.
2. **If the gateway checks tokens, why do services check again?** Defense in depth: a config mistake at the gateway
   (like forgetting `exp`) must not open the services. And roles and audiences are business rules the services own.
3. **Isn't the gateway a single point of failure?** Yes: measured 4 s of errors on restart, total outage when stopped.
   Fix: several gateway instances behind the load balancer, rolling restarts, config changes without restarts.
4. **How much latency does it add?** Here ~1 ms at the median (Kong's own work 0–1 ms). In the cloud it's mostly the
   extra network hop.
5. **Why not do auth in each service only?** Every service re-implements it, and every bad request costs every service
   CPU. With the gateway, a flood of fake tokens cost the shop nothing extra (E12b).
6. **How do you change gateway config without downtime?** DB-less Kong takes a whole new config through its admin API
   and swaps it atomically: 0 failures in 4 live changes.
7. **Gateway vs service mesh?** A gateway handles north-south traffic (clients → services). A mesh (sidecars) handles
   east-west traffic (service → service): mTLS, retries, tracing. Our payments → shop call still uses its own
   timeout, retry and breaker.

---

## 8. Self-quiz

1. Why did a **new** forged token per request get past NGINX's limit but not past Kong?
2. In E12b, what happened to the shop's CPU with and without the gateway, and why didn't any attacker get in either way?
3. Why did customers wait 13 extra seconds after Kong was already back, and what was the fix?
4. What does `claims_to_verify: [exp]` do, and what would happen without it?
5. How do you change Kong's config without failing requests?
6. Name one thing the gateway does NOT protect against in our setup.

<details><summary>Answers</summary>

1. NGINX limits per token value (50/s each), and every new token starts a fresh count. Kong checks the signature, which
   every forged token fails.
2. With Kong: 15–16%, the same as no attack. Without: 50–52%, the shop itself refused 60,000 requests. Nobody got in
   because the shop verifies signatures too; the gateway only moved the work.
3. NGINX's passive health check marked the only gateway down for 10 s after failures while it booted. Fix: `max_fails=0`
   for a single upstream.
4. Makes Kong refuse expired tokens. Without it, an expired but correctly signed token would pass the gateway (the shop
   would still refuse it).
5. Post the whole new config to the admin API (DB-less `POST /config`): Kong swaps it atomically.
6. The gateway itself being down (single instance); floods of anonymous requests from many IPs (needs a CDN/WAF);
   admin role checks (the shop does those).

</details>
