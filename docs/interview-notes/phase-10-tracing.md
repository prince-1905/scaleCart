# Interview notes — Phase 10: Distributed tracing (OpenTelemetry + Jaeger)

Evidence: [E13 experiment report](../experiments/E13-tracing.md). Plan: [phase-10 plan](../plans/phase-10-tracing.md).
Code: `apps/*/src/tracing.ts`, `apps/*/src/common/tracing-sampler.ts`, `apps/*/src/common/trace-context.ts`, the
outbox relays, `infra/kong/kong.template.yml` (opentelemetry plugin), `infra/jaeger/`.

---

## 1. The 30-second version

> "After splitting the system into services, metrics told me *that* Pay was slow, not *where*. I added OpenTelemetry
> tracing with Jaeger: Kong starts the trace, every service adds its steps (HTTP, MySQL, Redis, RabbitMQ), and I
> carried the trace through RabbitMQ by storing the `traceparent` in the outbox row. Over 20 payments the traces showed
> **79% of Pay's time is Razorpay's API**, not our code. One trace found a planted 2.8 s database lock without opening a
> log. The honest cost: tracing every request took the shop from ~39% to ~53% CPU at 300 req/s, and sampling 10% only
> brought it to ~49%, because most of the cost is the instrumentation itself."

---

## 2. The customer's (and support's) view

| Situation | What happens now | Measured |
|---|---|---|
| A customer says "Pay was slow" | Support takes the `X-Trace-Id` from the response, opens it in Jaeger, sees every step | Pay p50 321 ms: Razorpay 265 ms, shop lookup 2.6 ms |
| A checkout hangs | The trace names the slow step with its SQL | The planted lock: UPDATE stock 2.75–2.78 s, 3 of 3 runs |
| A payment arrives by webhook | One trace from Kong → payments → RabbitMQ → shop → RabbitMQ → payments | 59 of 60 complete across 3 runs (the 1 miss: Docker clock step) |
| Jaeger is down | Shopping works; the traces of that minute are lost | 13,290 of 13,290 requests ok |
| Every request is traced | The shop needs more CPU, and the slow tail grows | CPU ≈39% → ≈53%; p95 12–24 → 95–151 ms |

---

## 3. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Trace** | One request's whole journey across services, as a timeline | A parcel's tracking page |
| **Span** | One step in it (an HTTP call, a query, handling a message), with start, duration and parent | One scan at a depot |
| **Trace ID / `traceparent`** | The ID shared by all spans of a trace; the W3C header that carries it between services | The tracking number on the label |
| **Context propagation** | Passing the trace ID along: HTTP headers, message headers, the outbox row | Copying the tracking number onto every new label |
| **Instrumentation** | Code that creates spans automatically for libraries (HTTP, mysql2, redis, amqplib) | Scanners installed at every depot |
| **Sampling** | Keeping only some traces (head sampling: decided at the start) | Tracking 1 parcel in 10 in detail |
| **OpenTelemetry (OTel)** | The vendor-neutral standard + libraries for traces (and metrics, logs) | The barcode standard every courier uses |
| **Jaeger** | Stores traces and shows them | The tracking website |
| **Logs vs metrics vs traces** | What happened in one place / numbers over time / one request across places | Diary / thermometer / GPS track |

---

## 4. How a trace flows

```
Browser ──► Kong: new trace (or continues one), span "kong" ──traceparent──► payments
             payments: span "POST /orders/:id/payment"
               ├─ fetch → shop  (traceparent in the HTTP header) → shop's spans join the same trace
               ├─ MySQL queries (spans)
               └─ fetch → Razorpay (span)
Webhook ──► payments: saves payment + outbox row WITH the traceparent (same transaction)
             relay (later, every 200 ms): publishes the row INSIDE that trace → RabbitMQ message headers
             shop worker: consumer span continues the trace → marks paid → reply outbox row with ITS traceparent
             payments: consumes the reply, same trace
All services → OTLP (HTTP, in batches) → Jaeger :4318 → UI :16686
```
- **The sampler rule:** a new trace may only start at an incoming request or message. The relay's polling query every
  200 ms would otherwise create thousands of useless one-span traces (0 found in 246 checked).

---

## 5. The stories

### Story A — "Making our code faster wouldn't have helped" ⭐
- 20 Pays traced: total p50 **321 ms**, Razorpay's API **265 ms (79%, never < 65%)**, our call to the shop **2.6 ms**.
- Lesson: measure where the time goes before optimizing. The fix for a slow Pay would be on Razorpay's side (or
  creating the provider order earlier), not caching our order lookup.

### Story B — "One trace, no logs" ⭐
- Planted a 3 s lock on a stock row; one checkout's trace listed the slowest step: `UPDATE stock … WHERE product_id = ?`
  **2.75–2.78 s**, everything else ≤ 61 ms. 3 of 3 runs.

### Story C — "Carrying the trace through the queue" ⭐
- Problem: the outbox publishes events later, outside the request. Automatic instrumentation would start a new,
  disconnected trace.
- Fix: store the request's `traceparent` in the outbox row, and have the relay publish inside that context. The
  RabbitMQ instrumentation then puts it in the message headers; the consumer continues it.
- Proof: 59 of 60 webhook traces complete end to end. The outbox wait itself became visible: p50 24–107 ms (the
  200 ms poll).

### Story D — "Tracing isn't free, and sampling didn't fix it"
- 300 req/s: shop CPU ≈39% off → ≈53% every request → ≈49% with 10% sampling; p95 12–24 → 95–151 → 36–69 ms.
- Most of the cost is the instrumentation running on every request (patching, context in every async step), not
  exporting. Next: enable only the instrumentations we use.

### Story E — "Clocks broke my traces"
- Docker's VM clock is stepped back every ~27 s. A span crossing a step "ends before it starts"; Kong logged
  `invalid span duration` and dropped it, so one trace lost its Kong part. Tracing assumes monotonic clocks.

### Story F — "My measurements needed a power check"
- The charger kept connecting and disconnecting (18 Windows power events in 40 minutes), and one run froze for 17 s.
  I matched every run against the event log and only kept clean runs.

---

## 6. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| OpenTelemetry (not a vendor SDK) | Standard; switch Jaeger for Tempo, Datadog, etc. by changing the exporter | Fast-moving packages (versions renamed: `sdk-trace-base` → `sdk-trace`) |
| Auto-instrumentation | HTTP, MySQL, Redis, RabbitMQ spans with no code changes | CPU cost on every request, even unsampled ones |
| Head sampling (decide at the start) | Simple, cheap, complete traces | Can miss the rare slow/failing request (tail sampling keeps those, but needs a collector) |
| Trace context in the outbox row | One trace across the async boundary | One more column; context only, no extra rows |
| Only requests/messages start traces | No noise from polling loops | A slow background job is never traced on its own |
| Jaeger in memory, 20,000 traces | Zero setup | Traces lost on restart; production needs Elasticsearch/Cassandra/ClickHouse storage |
| `X-Trace-Id` in responses | Support can find a customer's request | Reveals an internal ID (harmless, random) |

---

## 7. Likely questions

1. **Logs, metrics or traces: when do you use which?** Metrics to know something is wrong (alerts, p95), traces to
   find where in a request, logs for the details inside one step. Our logs carry the trace ID to jump between them.
2. **How does the trace ID cross service boundaries?** The W3C `traceparent` header on HTTP calls; message headers on
   RabbitMQ; and, because our events go through an outbox, a column in the outbox row.
3. **Doesn't tracing slow everything down?** Measured: yes, ~35% more CPU with every request traced at 300 req/s; 10%
   sampling only partly helps because the instrumentation runs anyway. Use sampling plus only the instrumentations you
   need, and measure.
4. **Head vs tail sampling?** Head: decide at the start (cheap, but blind to how the request ends). Tail: keep traces
   after seeing them (keep all errors and slow ones), needs a collector buffering whole traces.
5. **What if the tracing backend is down?** The services export in the background and drop spans when their queue is
   full; requests are unaffected (measured 13,290 of 13,290 ok).
6. **Why did you see the trace only ~5 s later?** Spans are batched per service before sending. Tracing is for
   debugging, not real-time alerting.
7. **How would you run this in production?** An OpenTelemetry Collector per node (batching, tail sampling, routing),
   durable storage, sampling 1–10%, trace IDs in logs, exemplars linking metrics to traces.

---

## 8. Self-quiz

1. What are a trace, a span and a traceparent?
2. Why did the outbox need a new column for tracing?
3. Why don't the outbox relay's polling queries create traces?
4. What did the traces say about Pay's 321 ms?
5. Why did 10% sampling still cost ~10 points of CPU?
6. Why did one trace lose Kong's spans?

<details><summary>Answers</summary>

1. A trace is one request's whole journey; a span is one step in it (with a parent); the traceparent is the W3C header
   (`00-<trace id>-<span id>-<flags>`) that carries the trace ID and parent span to the next service.
2. Events are published later by the relay, outside the request. Storing the request's traceparent with the event lets
   the relay publish inside the same trace, so the consumer continues it.
3. The sampler only lets new traces start at an incoming request (SERVER) or message (CONSUMER); a query with no parent
   is dropped.
4. 265 ms (79%) was Razorpay's API; our shop lookup was 2.6 ms. Our code is not the bottleneck.
5. The instrumentation (patched libraries, context carried through every async step) runs for every request; sampling
   only skips recording and exporting.
6. The Docker VM's clock was stepped back during the request; the span "ended before it started", and Kong dropped it as
   an invalid duration.

</details>
