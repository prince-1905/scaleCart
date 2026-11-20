# Plan — Phase 10: distributed tracing (OpenTelemetry + Jaeger)

Decided with the owner (2026-11-20): **Jaeger** (`jaegertracing/jaeger:2.23.0`, one container, its own UI) as the
tracing backend, **OpenTelemetry** in the services. Branch `phase-10-tracing` from `main` after PR #16 (gateway).

## The question it answers

"This Pay click took 3 s: where did the time go?" Today we can find the request id in each service's log, one service
at a time. A trace shows the whole request as one timeline:

```
POST /orders/:id/payment                       412 ms   (Kong)
└─ payments  POST /orders/:id/payment           410 ms
   ├─ HTTP GET shop /internal/orders/:id          4 ms
   │  └─ shop  GET /internal/orders/:id           3 ms
   │     └─ MySQL SELECT orders                   1 ms
   ├─ MySQL INSERT payment_attempts               2 ms
   └─ HTTP POST api.razorpay.com/v1/orders      380 ms   ← the slow part
```

## Pieces

| Piece | What |
|---|---|
| OpenTelemetry SDK in shop API, shop worker and payments | `src/tracing.ts` loaded before the app (`node --import`): auto-instrumentation for HTTP (in and out), Fastify, mysql2, Redis, amqplib |
| Kong `opentelemetry` plugin | Kong's own span, and the trace starts at the door (W3C `traceparent` header) |
| Context through RabbitMQ | The outbox stores the `traceparent` with each event; the consumer continues the same trace. So "webhook → payment.captured → shop marks paid → reply" is one trace |
| Jaeger | Receives OTLP on 4318, UI on http://localhost:16686 |
| Switch | `TRACING_ENABLED` (off in unit/e2e tests unless a test turns it on), sampling ratio `TRACING_SAMPLE_RATIO` |
| Logs | trace id in every log line, next to the request id |

## E13 — what we will measure

1. **Cost of tracing:** the same load with tracing off / on (100% sampled) / 10% sampled: latency and CPU.
2. **Finding a slow part:** make one dependency slow on purpose (e.g. a slow shop or a slow MySQL query) and find it
   in Jaeger from one trace, without reading logs.
3. **One trace across the queue:** a webhook and the order turning paid in the same trace; the queue wait is visible.
4. **When Jaeger is down:** do the services slow down or fail? (Spans are exported in the background, in batches.)
