# Plan — Phase 9: an API gateway (Kong) in front of the services

Decided with the owner (2026-11-17): **Kong**, the open-source image `kong:3.9.4`, in **DB-less mode** (all config in
one YAML file, no Kong database). Branch `phase-9-api-gateway` from `main` after PR #15 (payments service) is merged.

## Today

```
Browser ──► NGINX :8088 ──► /shop/, /demo/            static files
                       ├──► /orders/:id/payment, /payments/*   ──► payments (:3002)
                       ├──► /internal/*                        ──► 404
                       └──► everything else                    ──► shop API (:3000)
NGINX also: per-token flood limit (limit_req 50/s), X-Real-IP.
Each service checks the login token itself, every request, even a forged one.
```

## After

```
Browser ──► NGINX :8088 (edge: static files, TLS later, client IP)
              └──► Kong :8000 (gateway)
                     ├── routes:  /payments/*, /orders/:id/payment ──► payments
                     │            everything else                  ──► shop
                     │            /internal/* has no route           ──► 404
                     ├── jwt:     protected routes need a valid token (HS256, iss "scalecart", not expired)
                     │            → forged / expired / missing token refused AT THE DOOR (401)
                     ├── correlation-id: every request gets X-Request-ID (sent to services, logged, echoed back)
                     └── prometheus: per-route counts, Kong's own time vs the service's time
```

- **Rate limiting stays in NGINX + the shop** (decided while building): Kong's open-source limiter counts fixed
  windows, and requests without a token fall back to per-IP counting, which would throttle anonymous browsing and the
  older load tests. NGINX's per-token limit (E9) already does the edge job.
- **Defense in depth:** the services still verify tokens (role, audience, 2FA challenge). Kong is the first filter,
  not the only one.
- **Public routes** (browse, search, login, register, webhooks, health) have no jwt plugin. The webhook route has no
  rate limit either (Razorpay retries).
- The JWT secret is not written into the YAML: the container builds `kong.yml` from a template at start, using `.env`.

## Steps

| Step | What |
|---|---|
| 9a | `infra/kong/kong.template.yml` + compose service `gateway` (kong:3.9.4, DB-less), NGINX sends API paths to Kong |
| 9b | Plugins: jwt (protected routes), request-termination (/internal, /metrics), correlation-id, prometheus (+ Prometheus job) |
| 9c | Both apps log `X-Request-ID` from the gateway (first step towards tracing) |
| 9d | `infra/kong/check-gateway.mjs`: routing, 401 at the gateway, valid token passes, /internal 404, webhook reaches payments, request id echoed. Existing e2e suites unchanged (they test the apps directly) |
| 9e | **E12 experiment** (below) |
| 9f | Docs: E12, interview notes phase-9, workflow section, README |

## E12 — what we will measure

1. **Cost of the gateway:** the same product page through Kong vs a lab port that skips it (fixed rate, several runs),
   plus Kong's own latency metric.
2. **Forged-token flood:** many requests per second with bad tokens next to normal shoppers: how many reach the shop,
   shop CPU / event loop, shoppers' p95. With the gateway vs without.
3. **Gateway down / restarting:** what customers see, and how long it takes. A gateway is a single front door: the
   honest trade-off.
4. **Config change under load:** reload a changed route while traffic flows: any failed requests?
