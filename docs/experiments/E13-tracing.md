# E13 — Distributed tracing (OpenTelemetry + Jaeger): what it shows, and what it costs

**Date:** 2026-11-20 · **Phase:** 10 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop. **Charger connection unstable** that day (see "Power" below) |
| Path | NGINX → Kong 3.9.4 (opentelemetry plugin) → shop API / payments / shop worker (OpenTelemetry Node SDK 0.300, auto-instrumentation 0.82: HTTP in/out, fetch, mysql2, redis, amqplib, pino) → **Jaeger 2.23.0** (in memory, max 20,000 traces) |
| Trace through the queue | The outbox row stores the request's W3C `traceparent`; the relay publishes inside that trace; RabbitMQ carries it in the message headers; the consumer continues it |
| Sampler | A new trace starts only at an incoming request or message; everything else follows its parent; background work (outbox polling, jobs) is never traced |
| Switches | `TRACING_ENABLED` (services), `TRACING_SAMPLE_RATIO` (new traces kept; Kong uses the same ratio) |
| Scripts | `infra/jaeger/check-tracing.mjs` (real payments, traces read back from Jaeger), `load-tests/e13-find-slow.mjs`, `load-tests/e12-gateway.js` (load), `load-tests/e12-gateway-ops.mjs jaeger` |
| Raw data | `load-tests/results/e13*` (`e13r-summary.md` + `e13s-summary.md`: the cost runs used below; `e13-summary.md`: the first, discarded batch) |

**Power:** Windows logged "power source changed" (event 105) 18 times during the first cost batch and kept doing it
afterwards: the charger connection was flapping, which changes CPU speed. Every cost run below was checked against the
event log, and **only runs with no power event inside them are counted**. The first batch is not used at all: it also
had a 17 s freeze, when the whole Docker VM stopped and one run collapsed (p95 9.2 s, 866 errors).

---

## E13a — The cost: the same load with tracing off, on for every request, and on for 10%

300 product-page requests/s through Kong (logged in, cached in Redis), 60 s per run, settings interleaved.

| Tracing | Clean runs | Shop CPU (avg, % of one core) | Shop event loop busy (max) | Shoppers p50 / p95 / p99 | Kong CPU | Jaeger CPU |
|---|---|---|---|---|---|---|
| **Off** | 3 | **37.4–40.5%** | 0.46–0.51 | 2.1 / **12–24** / 94–107 ms | 17.6–18.3% | ~0 |
| **Every request** | 3 | **51.4–55.4%** | 0.63–0.71 | 2.2–3.2 / **95–151** / 201–297 ms | 19.9–22.1% | 1.1–1.7% |
| **10% sampled** | 4 | **45.7–51.2%** | 0.59–0.63 | 2.2–2.6 / **36–69** / 170–359 ms | 18.1–20.2% | 0.3–0.8% |

0 errors in all 10 runs. Discarded: one "off" run whose setup failed (logins got 504 right after Kong was recreated),
and 2 runs with power events inside them.

- **Tracing every request cost the shop ~35% more CPU** (≈39% → ≈53% of a core), and the slow tail grew: p95 from
  12–24 ms to 95–151 ms. The median didn't move (~2 ms).
- **Sampling 10% saved less than expected:** CPU ≈49%, p95 36–69 ms. Most of the cost isn't sending spans to Jaeger:
  it's the instrumentation itself (patched libraries, carrying the context through every async step), which runs for
  every request, even the 90% that aren't recorded.
- Kong's own tracing cost little (+2–4 points of a core); Jaeger used under 2% of a core.
- Kong's added latency stayed at 0–1 ms in all settings.
- Not tried yet: turning off the instrumentations we don't use (the auto package patches many libraries), which is where
  the remaining overhead should come from.

## E13b — Finding a planted slow spot from ONE trace

`/lab/hold-stock-lock` keeps one product's stock row locked for 3 s (like a commit stuck on a slow disk, E3e); 200 ms
later a customer checks out that product. The script reads the checkout's trace (by Kong's `X-Trace-Id`) and lists the
slowest steps with no children:

| Run | Checkout | Slowest step | Next slowest |
|---|---|---|---|
| 1 | 2,786 ms | **2,759 ms** `UPDATE stock SET available = available - ? WHERE product_id = ? AND available >= ?` | 61 ms COMMIT |
| 2 | 2,686 ms | **2,754 ms** same UPDATE | 15 ms DELETE cart_items |
| 3 | 2,668 ms | **2,775 ms** same UPDATE | 14 ms DELETE cart_items |

- 3 of 3: the trace points straight at the stock UPDATE waiting for the lock, with the exact SQL. No logs opened.
- The span can look slightly longer than the whole checkout: the shop measures inside Docker, the script on Windows,
  and the Docker VM's clock drifts (see E13c).

## E13c — One trace across services and RabbitMQ (and where Pay's time goes)

`check-tracing.mjs` with N=20: checkout → Pay (real Razorpay test order) → a self-signed `payment.captured` webhook,
then both traces are read back from Jaeger.

| | Run A (`e13-queue-1`) | Run B (`e13-queue-2`) | Run C (`e13-queue-3`) |
|---|---|---|---|
| Pay traces complete (Kong → payments → shop) | **20 of 20** | **20 of 20** | **20 of 20** |
| Webhook traces complete (Kong → payments → RabbitMQ → shop worker → RabbitMQ → payments) | **19 of 20** (see the clock problem below) | **20 of 20** | **20 of 20** |
| Event waiting in the payments outbox (webhook done → published), p50 / max | 62 / 180 ms | 107 / 194 ms | 24 / 160 ms |
| Webhook arrives → the shop's reply handled by payments, p50 / max | 334 / 961 ms | 320 / 431 ms | 326 / 601 ms |
| A Pay trace complete in Jaeger after (p50 / max) | 4.6 / 4.7 s | 4.6 / 5.2 s | 4.6 / 4.9 s |
| Traces started by background work (outbox polling, jobs) | 0 of 83 | 0 of 123 | 0 of 40 |

**Where Pay's time goes** (run C, 20 Pays): total p50 **321 ms** (max 749): **Razorpay's API 265 ms** (max 526),
the shop lookup 2.6 ms (max 21.8). Razorpay was **79%** of Pay at the median, never less than 65%. Making our own code
faster would barely change what the customer feels.

- The outbox wait is the relay's 200 ms polling, now visible for every single payment.
- Spans reach Jaeger ~5 s late: each service sends them in batches. Fine for debugging, not for alerts.
- **An earlier run is not counted:** my check stopped waiting when the shop's spans arrived and failed when Kong's batch came
  later (14 and 13 of 20 "complete"). Read again later, the traces were complete. The check now waits for every service.

**A real tracing problem found:** the one incomplete trace in run A had no Kong spans, and Kong had logged
`invalid span duration` (4 times in the 40 minutes up to then; 2 more during run B). The
Docker VM's clock runs fast and gets stepped back every ~27 s (seen since E5). A span that straddles a step ends
"before" it started, and Kong drops it. That trace also showed the webhook "starting" 791 ms after its own child spans: a clock
step in the middle of the request. **Tracing assumes clocks only move forward.** Real servers usually slew
the clock gently instead of jumping.

## E13d — Jaeger down for 60 s

100 product-page requests/s (+ the shop's start page), `docker compose stop jaeger`, 60 s, `start`.

| | Run 1 | Run 2 |
|---|---|---|
| Product pages while Jaeger was down | **6,690 of 6,690 ok** | **6,600 of 6,600 ok** |
| …after Jaeger came back | 2,275 of 2,275 ok | 2,406 of 2,679 ok (see below) |
| Memory: shop / payments / Kong, before → after 60 s down | 258 → 303 / 133 → 133 / 220 → 316 MB | 310 → 310 / 133 → 133 / 342 → 371 MB |

- Customers didn't notice: the services export in the background and drop spans when their queue is full. Kong logged
  queue errors (about 1,100 lines) and carried on.
- Memory: the shop grew 45 MB in run 1 and not at all in run 2; Kong grew 29–96 MB.
- **Two bursts of failures not caused by Jaeger:** 30 requests at 10.55 s in run 1 (before Jaeger was touched) and 273
  within ~1.2 s in run 2 (~4.6 s after its start command). All got no answer at all (status 0), and **NGINX and Kong
  logged nothing** at those moments, so they never reached NGINX. They were lost in Docker Desktop's port forwarding on
  the Windows side. No power events at those moments.

---

## Tests

All passing on 2026-11-20: shop 75 unit, 180 end-to-end; payments 16 unit, 25 end-to-end; gateway checks 16 of 16;
`check-tracing.mjs` all checks.
- New unit tests (`src/common/tracing.spec.ts`, 7): the sampler (follow the parent; new traces only at a request or
  message; background work dropped; ratio for new traces only) and carrying a traceparent through the outbox.
- Mutation-checked: removing the "background work" rule, and making `withTraceparent` ignore the saved traceparent,
  each made a test fail.
