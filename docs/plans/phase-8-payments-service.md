# Plan — Phase 8: split payments into its own service

Decided with the owner (2026-11-16): **events + a sync call only where an instant answer is needed**, packaged as
**its own app** (`apps/payments`: own package.json, Dockerfile, image, container, MySQL login).

## Today (one app)

`PaymentsService` calls three modules directly, as function calls:
- **orders:** `get`, `markPaid`, `cancelIfUnpaid`, `overdue`
- **inventory:** `commit`, `release`
- **drops:** `releaseOrder`

The worker's `PaymentJobs` expires unpaid orders (after asking Razorpay) and sends refunds.

## After the split

```
Browser ──► NGINX ──► /orders/:id/payment, /payments/*  ──► payments-svc (:3002) ── MySQL scalecart_payments
                 └──► everything else                    ──► shop API (:3000)     ── MySQL (the other 6 DBs)

payments-svc ──HTTP──► shop  GET /internal/orders/:id        "amount, owner, status?"   (start a payment)
shop worker  ──HTTP──► payments-svc  POST /internal/orders/:id/reconcile   "paid after all?" (before cancelling)
             both: service token header, timeout, 1 retry, circuit breaker; NGINX never routes /internal/*

payments-svc ──event──► RabbitMQ  payment.captured {orderId, paymentId, amountPaise}   (via its own outbox)
shop worker  : mark paid (conditional UPDATE) → commit stock → event order.payment_result {paid | already_paid |
               paid_by_other | cancelled}                                               (via the shop's outbox)
payments-svc : paid_by_other / cancelled → refund_pending → refund job (as today)
```

**Who owns what:**

| Data / decision | Owner |
|---|---|
| Order status (pending → paid / cancelled), stock, drop purchases, the payment deadline | **shop** |
| Payment attempts, payments, webhook events, refunds, talking to Razorpay | **payments-svc** |

**Login tokens:** payments-svc verifies the same HS256 JWTs (shared secret) for now. The API-gateway phase moves
token checks to the gateway.

## Steps

1. **8a Scaffold:** `apps/payments` with Nest + Fastify, config, metrics, health, its own migrate entry and MySQL user.
2. **8b Move the domain:** gateway, signatures, attempts/payments/webhook_events, controllers. No imports from the shop.
3. **8c Sync calls:** shop `GET /internal/orders/:id`; payments `POST /internal/orders/:id/reconcile`. Clients with
   timeout + retry + circuit breaker.
4. **8d Events:** payments outbox + relay → `payment.captured`; shop worker consumer → `order.payment_result` →
   payments consumer. Every consumer dedups by event id (inbox).
5. **8e Shop side:** remove the payments module from the API and worker; the expire job asks payments-svc before
   cancelling (skip if it can't).
6. **8f Wiring:** NGINX routes, Compose service, k8s manifests (light). The frontend should need no change
   (same URLs).
7. **8g Tests:** payments-svc e2e (fake shop + fake Razorpay + real MySQL/RabbitMQ); shop consumer e2e; one end-to-end
   run of both.
8. **8h Experiment E11 + docs:**
   - cost of the extra hop (start payment, before vs after)
   - webhook → order paid delay through the queue
   - **shop down for 60 s:** webhooks still accepted, orders catch up
   - **payments down:** browsing/checkout unaffected, expiry skips
   - **slow shop:** the circuit breaker fails fast
