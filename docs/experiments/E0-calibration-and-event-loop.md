# E0 — Test-rig calibration and the Node.js event loop

**Date:** 2026-10-27 · **Phase:** 0 · **Status:** done

## Setup (applies to every run below)

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H (6 performance + 4 efficiency cores, 16 threads), 15.7 GB RAM, Windows 11 |
| Docker | Docker Desktop 28.3.2 (WSL2 VM: 16 vCPUs, ~7.6 GB) |
| System under test | 1 × `api` container — NestJS 12.3, **Fastify** adapter, Node 24.22.1, **CPU limit 1.0, memory 512 MiB**, access logs off |
| Path | k6 (native Windows) → `localhost:8088` → Docker port forwarding → NGINX 1.30 → `api:3000` |
| Load generator | k6 v2.2.0, **open model** (`constant-arrival-rate`), 20 s per step, warm-up step first |
| Raw data | `load-tests/results/<run-id>.*` (not committed); run ids listed per experiment |

**Limitations:** laptop with hybrid P/E cores and turbo, so absolute numbers vary between runs. k6, NGINX
and the app share the same CPU. Each experiment was run once (Phase 2 adds repetitions).
Treat these numbers as *this machine's* numbers. The **shapes** — where the knee is and why — are what generalise.

> **Note on "achieved rps" for overloaded steps:** k6 lets requests that started in a step finish after
> the step ends, so for overloaded steps `achieved` (= completed / 20 s) overstates real throughput.
> True peaks below come from the server's own metric (`rate(http_server_request_duration_seconds_count[20s])`).

---

## E0a — How much can the test rig itself measure?

**Question:** before blaming the app, what is the ceiling of k6 + Docker networking + NGINX?
**Method:** `/static-ok` is answered by NGINX itself and never reaches Node. Step the rate up.
**Run:** `e0-calibration-20261027-154035`

| Target rps | Achieved | p50 ms | p95 ms | p99 ms | Dropped | Notes |
|---|---|---|---|---|---|---|
| 2,000 | 1,997 | 0.5 | 5.8 | 31.9 | 63 | |
| 5,000 | 4,981 | 0.6 | 3.2 | 10.8 | 378 | |
| 8,000 | 7,964 | 1.1 | 7.4 | 17.8 | 711 | |
| 12,000 | 11,749 | 3.3 | 27.2 | 42.5 | 5,029 | |
| 16,000 | 15,163 | 8.3 | 49.5 | 67.9 | 16,744 | host CPU peaked at **94.5%** |

**Result:** this laptop measures reliably up to **~8,000 req/s**. Above ~12,000 req/s, k6 can't start
requests on time (rising `dropped_iterations`) and the host CPU is saturated, so results there
describe the laptop, not the app. **Any app result near 8k+ req/s on this machine must be distrusted.**

## E0b — Ceiling of one Node.js process doing (almost) nothing

**Method:** `/lab/ping` returns `{ok:true}` through NestJS + Fastify, 1 CPU. Same run as E0a.

| Target rps | Achieved | p50 ms | p95 ms | p99 ms | Errors | Dropped |
|---|---|---|---|---|---|---|
| 1,000 | 1,000 | 1.6 | 11.5 | 31.8 | 0% | 0 |
| 2,000 | 1,991 | 1.1 | 15.1 | 53.0 | 0% | 173 |
| 3,000 | 2,970 | 1.6 | 56.1 | 96.9 | 0% | 610 |
| 4,000 | 3,887 | 2.8 | 94.5 | 245.7 | 0% | 2,264 |
| 5,000 | 4,178 | 146.6 | 1,922.6 | 2,522.5 | **6.03% (HTTP 504)** | 16,450 |
| 6,000 | 4,310 | 316.2 | 509.3 | 848.8 | 0% | 33,798 |

- **Peak server throughput: 4,329 req/s** (20 s window), event-loop utilization **1.0**, CPU ≈ 1 core.
- The knee is around **3,000 req/s**: latency rises well before throughput stops growing.
- The rig ceiling (~8k) is about 2× the app ceiling (~4.3k), so **the app, not the rig, was the bottleneck.** ✅ valid
- **The 504s:** Node never returned an error. Requests waited in the overloaded process's queue for
  more than 30 s, until NGINX's `proxy_read_timeout` gave up. Overload shows up as **queueing**, then **timeouts**.

## E0c — Waiting vs. working: the event loop

### Waiting: `/lab/io?ms=50` (non-blocking 50 ms wait, like a DB call)

Run `e0-event-loop-20261027-154546`

| Target rps | Achieved | p50 ms | p95 ms | p99 ms | Dropped |
|---|---|---|---|---|---|
| 500 | 500 | 50.3 | 67.8 | 95.6 | 0 |
| 1,000 | 1,000 | 49.5 | 68.1 | 89.4 | 0 |
| 2,000 | 1,966 | 52.3 | 137.4 | 220.6 | 681 |
| 3,000 | 2,769 | 193.9 | 412.8 | 2,578.4 | 4,616 |

- At 2,000 req/s × 50 ms, **~100 requests wait at the same time on one thread**, and latency stays ≈ 50 ms.
  Peak in-flight during the run: **717** concurrent requests.
- Peak server throughput **2,706 req/s**. The limit is **not** the waiting; it is the CPU cost of handling
  each request (framework, JSON, timers). That's why it saturates a bit below `/lab/ping` (~4.3k).

### Working: `/lab/cpu?ms=5` (5 ms of real CPU work on the JS thread)

Run `e0-event-loop-cpu-20261027-155503`

| Target rps | Achieved* | p50 ms | p95 ms | p99 ms | Errors | Dropped |
|---|---|---|---|---|---|---|
| 100 | 100 | 8.8 | 32.4 | 66.5 | 0% | 0 |
| 150 | 142 | 668.6 | 4,014 | 15,247 | 0% | 164 |
| 175 | 154 | 1,499 | 15,426 | 28,772 | 3.3% | 418 |
| 200 | 166 | 2,197 | 28,750 | 28,764 | 10.9% | 679 |
| 250 | 222* | 1,949 | 3,400 | 4,917 | 33.8% | 565 |

\* overstated for overloaded steps (see note at the top).

- **Theory:** one thread doing 5 ms per request can do at most 1000 / 5 = **200 req/s**.
- **Measured:** **~145–170 req/s** (server-side, 20 s windows). Past that, latency goes from milliseconds to
  **seconds**, then 504 timeouts. Compare: the *waiting* endpoint handled **~16× more** traffic.
- **Why below 200?** During saturation the event loop reported **100% busy** (ELU = 1.0), but the process
  only got **0.71–0.86 cores** of CPU. CFS throttling explains only ~3–4% of time. The rest is the thread
  being runnable but not scheduled: the Docker VM shares a hybrid-core laptop with Windows and k6.
  **A CPU *limit* of 1 is not a dedicated core.** (To repeat on dedicated cloud vCPUs in Phase 9.)

### Head-of-line blocking: cheap requests stuck behind CPU work

Run `e0-event-loop-hol-20261027-155946` — `/lab/ping` at 200 req/s, alone vs. alongside `/lab/cpu?ms=5` at 75 req/s
(≈ 50% of the process's CPU capacity; no overload, no errors).

| Scenario | p50 ms | p95 ms | p99 ms |
|---|---|---|---|
| ping alone | 1.7 | 3.7 | **8.0** |
| ping + background CPU work | 2.5 | 9.4 | **31.9** |
| (the CPU requests themselves) | 8.4 | 11.4 | 34.6 |

`/lab/ping` does no work, yet its **p99 got 4× worse** with the event loop only ~60% busy. A ping that arrives
during a 5 ms computation must wait for it to finish. **One CPU-heavy endpoint degrades every endpoint on
that process.** Fixes: move CPU work to worker threads or a separate service, or run more processes.

---

## A measurement mistake, caught and fixed

The first version of `/lab/cpu` burned CPU until **wall-clock** time passed 5 ms. It reported ~220 req/s,
above the 200 req/s that's physically possible. The container's `cpu.stat` showed it was **throttled in
590 of 9,018 scheduler periods (39 s total)**: when throttled, wall-clock time keeps running but no work is
done, so each "5 ms" request did less than 5 ms of work. The endpoint now uses `process.threadCpuUsage()`
(CPU time of the JS thread). Throttling is exported as `container_cpu_throttled_seconds_total`.
The superseded run is `e0-event-loop-20261027-154546` (its io results above are unaffected).

## Conclusions

1. Rig ceiling ≈ 8k req/s on this laptop: keep app tests well below it, or move k6 to another machine.
2. One Node process (1 CPU): **~4.3k req/s** for trivial requests, **~2.7k** with a 50 ms async wait,
   **~150** for 5 ms CPU work. **Throughput depends on CPU per request, not on how long requests wait.**
3. Overload → queueing → latency explodes → timeouts. Without load shedding, users wait 30 s and then fail.
4. CPU-bound work blocks everything on the same event loop (head-of-line blocking).
5. CPU limits ≠ dedicated cores: watch event-loop utilization *and* actual CPU *and* throttling together.
