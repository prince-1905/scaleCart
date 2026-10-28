# E2 — Accept-queue fix, Redis cache, Fastify vs Express, scaling up vs out

**Date:** 2026-10-28 · **Phase:** 2 · **Status:** done

## Setup (applies to every run below)

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H (6P + 4E cores, 16 threads), 15.7 GB RAM, Windows 11 |
| Docker | Docker Desktop 28.3.2 (WSL2 VM: 16 vCPUs, ~7.6 GB) |
| API | NestJS 12.3, Node 24.22.1, **1 replica × 1.0 CPU, 512 MiB** unless the experiment changes it; access logs off |
| Data stores | MySQL 8.4.13 (2 CPUs, 1 GiB) · **Redis 8.8.2** (1 CPU, 256 MB, `allkeys-lru`, no persistence) |
| Path | k6 v2.2.0 (Windows) → NGINX 1.30 (`localhost:8088`) → API → MySQL / Redis |
| Script | `load-tests/e2-throughput.js` (stepped open-model rates, 20 s per step) unless noted |
| Peak throughput | Server-side: best 20 s window of `sum(rate(http_server_request_duration_seconds_count{route=…,status_code="200"}[20s]))`, skipping the first 13 s of each run |
| Raw data | `load-tests/results/<run-id>.*` (not committed) |

**Limitations:** one laptop runs k6, NGINX, the API(s), MySQL and Redis. Runs of the *identical* setup varied by
up to ~25% (see E2b), so differences smaller than that are not claimed. Scale-out to 4 replicas drove host
CPU to 95.8%, so that number is the laptop's limit, not the design's.

---

## E2a — The 504s from E1: proving the cause, then fixing it

**Problem (from E1):** 1,000 buyers × 2 simultaneous checkout requests → hundreds of NGINX `504`s
("upstream timed out while connecting").

**Hypothesis:** Node accepts connections from a kernel queue (the *listen backlog*). Node asks for **511**
places by default. A burst of 2,000 new NGINX→Node connections overflows it, the kernel drops the extra
connection attempts, and NGINX gives up after its 2 s connect timeout.

**Proof:** the kernel counts every turned-away connection attempt in `TcpExtListenOverflows`
(`/proc/net/netstat` inside the API container). Max allowed backlog there: `net.core.somaxconn = 4096`.

**Fix:** `HTTP_LISTEN_BACKLOG=4096`, passed to Fastify's `listen({ backlog })` (Express: `server.listen(port, host, backlog)`).

**Method:** `e1-flash-sale.js PART=double-click`, 1,000 buyers, 2 requests each, stock 2,000. Orders per
buyer checked in MySQL.

| Run | Backlog | Accept-queue overflows | 504s | Buyers with an order | Max orders per buyer | Checkout p50 / p99 |
|---|---|---|---|---|---|---|
| `e2-burst-backlog511-20261028-120953` | 511 | **4,322** | **716** | 821 / 1,000 | 1 | 2,980 / 6,415 ms |
| `e2-burst-backlog4096-20261028-121202` | 4,096 | **0** | **0** | **1,000 / 1,000** | 1 | 4,591 / 7,234 ms |
| `e2-burst-backlog4096-20261028-121327` | 4,096 | **0** | **0** | **1,000 / 1,000** | 1 | 7,891 / 27,082 ms |

(A first check before the fix, during development, showed the same thing: +3,031 overflows and 506 failed requests.)

- **Cause confirmed and fixed:** overflows went from thousands to **0**, 504s from 716 to **0**, and every buyer got
  exactly one order.
- **But the fix moved the queue, it didn't remove it.** Requests that used to be refused now wait *inside* the
  app: p50 went from ~3 s to 4.6–7.9 s, and one run's p99 reached **27 s**, close to NGINX's 30 s timeout.
  1 CPU can only do so many checkouts per second. Real fixes for a drop: a **waiting room / admission control**
  (let people in at the rate we can serve), load shedding (fast 503 instead of a 27 s wait), or more replicas.

## E2b — Redis cache-aside for product pages

**Method:** `GET /products/:id`. "Hot" = random id among **1,000** popular products (a drop). "Uniform" = random
among all **200,000**. Redis emptied (`FLUSHALL`) before each run. Cache lookups from `cache_requests_total`, MySQL
reads from `SHOW GLOBAL STATUS LIKE 'Com_select'` before/after.

| Run | Cache | Ids | Peak req/s | Hit ratio | MySQL SELECTs in run |
|---|---|---|---|---|---|
| `e2-cache-off-hot1000-20261028-121517` | off | hot 1,000 | **1,486** | – | **146,615** |
| `e2-cache-on-hot1000-20261028-121806` | on | hot 1,000 | **2,435** | 93.5% | **6,802** |
| `e2-cache-on-hot1000-20261028-130432` | on | hot 1,000 | **3,081** | 96.0% | **4,476** |
| `e2-adapter-fastify-product-20261028-122605`* | on | hot 1,000 | 2,870 | – | – |
| `e2-adapter-fastify-product-20261028-131509`* | on | hot 1,000 | 3,051 | – | – |
| `e2-cache-on-uniform200k-20261028-122052` | on | all 200,000 | **1,633** | **22.0%** | 120,230 |

\* Same configuration, run as part of E2c (cache not emptied first).
For comparison, cache off with uniform ids: 1,363 (`e2-scale-r1-c1.0-product-20261028-123412`) and 1,360 (E1).

Latency at 2,000 req/s offered (hot set):

| Cache | Achieved | p50 ms | p99 ms |
|---|---|---|---|
| off | 1,493 (overloaded) | 1,168.7 | 1,994.5 |
| on (`…121806`) | 1,940 | 11.4 | 644.7 |
| on (`…130432`) | 1,991 | 1.1 | 128.7 |

- **Throughput: 1.6–2.1×** (1,486 → 2,435–3,081 req/s on 1 CPU). Not 10×: the API process is still the
  bottleneck (event loop 100% busy). A cache hit still costs a Redis round trip, JSON parsing and the framework.
- **Database load: −95 to −97%.** 146,615 → 4,476–6,802 SELECTs for the same test. That's the bigger win:
  MySQL is left free for what can't be cached (checkout, stock).
- **A cache only helps when reads repeat.** Spreading reads over all 200k products: **22% hit ratio**, 1,633 req/s,
  barely better than no cache.
- **Fail-open under overload:** 1,966–4,859 lookups per run counted as `unavailable`: Redis didn't answer
  within 200 ms. These happened at the overloaded steps, where our own event loop was 100% busy, so the timer
  was mostly measuring *our* backlog, not Redis. Those requests fell back to MySQL instead of failing. Overloaded
  steps also had 0.05–0.19% errors in run `…121806`.
- **Coalescing at work:** 4,990–5,686 lookups per run waited for another request's load instead of each
  querying MySQL (no stampede after the cold start).

## E2c — Fastify vs Express (same app, only the HTTP layer changes)

**Method:** `HTTP_ADAPTER=fastify|express`, two rounds (second round in swapped order). `ping` = framework only;
`product` = cached product page (hot set), i.e. framework + Redis + JSON.

| Endpoint | Fastify (round 1 / 2) | Express (round 1 / 2) | Fastify advantage |
|---|---|---|---|
| `/lab/ping` | 5,118 / 4,695 | 3,617 / 3,396 | **+38–42%** |
| `/products/:id` (cached) | 2,870 / 3,051 | 2,272 / 2,436 | **+25–26%** |

Runs: `e2-adapter-{fastify,express}-{ping,product}-20261028-{1223xx…1231xx, 1307xx…1315xx}`.

- Fastify is consistently faster, but **the gap shrinks as real work grows**: +40% with no work, +25% with one
  Redis lookup. With a MySQL query or Argon2 per request it shrinks further, because the framework becomes a
  small slice of each request's cost.
- Interview point: switching frameworks is a fixed overhead win. Caching, query shape and scaling move the needle more.

## E2d — Scale up (more CPU per process) vs scale out (more processes)

**Method:** product reads with **cache off** (each request = 1 MySQL query, event-loop-bound) and login
(Argon2id on libuv's 4-thread pool, CPU-bound off the event loop). Rates up to 6,000 (product) and 100–180
(login). Throttled time = `increase(container_cpu_throttled_seconds_total)` summed over all replicas; it is
added up per CPU, so it can exceed wall-clock time. Compare it with CPU used.

### Product page from MySQL (event-loop-bound)

| Setup | Total CPUs | Peak req/s | vs 1×1 | CPU actually used |
|---|---|---|---|---|
| 1 replica × 1 CPU | 1 | 1,363 | 1.0× | |
| 1 replica × 2 CPUs | 2 | 1,991 | 1.46× | max 1.40 cores |
| 1 replica × 4 CPUs | 4 | 2,101 | 1.54× | max 1.54 cores (avg 1.08 over the run, 0.1 s throttled) |
| 2 replicas × 1 CPU | 2 | 2,455 | **1.80×** | |
| 4 replicas × 1 CPU | 4 | 2,993 | **2.20×** | host CPU 95.8% ⚠ |

### Login (Argon2id on the thread pool)

| Setup | Total CPUs | Peak logins/s | vs 1×1 | Throttled s per CPU-second used |
|---|---|---|---|---|
| 1 × 1 CPU | 1 | 21 | 1.0× | 3.7 |
| 1 × 2 CPUs | 2 | 39 | 1.9× | |
| 1 × 4 CPUs | 4 | 97 / 101 | **~4.7×** | **0.1** |
| 2 × 1 CPU | 2 | 32 | 1.5× | 3.7 |
| 4 × 1 CPU | 4 | 77 / 63 | 3.0–3.7× | **3.8** |

Runs: `e2-scale-r{1,2,4}-c{1.0,2.0,4.0}-{product,login}-20261028-*` (login r1-c4 and r4-c1 run twice).

- **Event-loop-bound work doesn't scale up.** One Node process has one JavaScript thread: giving it 4 CPUs used
  at most 1.54 of them (+54%). The extra gain comes from Node's helper threads (GC, I/O). **Scaling out** with
  the same total CPU did better: 2 × 1 CPU = 1.80× vs 1 × 2 CPUs = 1.46×.
- **Thread-pool work does scale up.** Argon2 runs on 4 pool threads, so one 4-CPU process gave ~4.7× and was
  barely throttled. Four 1-CPU processes each run *4 hashing threads on a 1-CPU budget*, hit the quota constantly
  (3.8 s throttled per CPU-second), and reached only 3.0–3.7×.
- **Rule:** know where the work runs. JavaScript on the event loop → more processes. Native thread-pool work →
  give each process as many cores as pool threads (`UV_THREADPOOL_SIZE`, default 4).
- 4 × 1 CPU for product reads stopped at ~3k with the **laptop at 95.8% CPU**, so the true scale-out limit
  (or MySQL's) wasn't reached here. That's for the cloud tests later.

---

## Conclusions

1. **504s solved by evidence:** 4,322 accept-queue overflows → 0 with a 4,096 backlog; 1,000/1,000 buyers served.
   The queue moved into the app (p99 up to 27 s), so a drop still needs admission control.
2. **Cache-aside:** 1.6–2.1× throughput, **95–97% fewer MySQL reads** on a hot set; useless (22% hits) on
   uniform traffic. Fail-open kept requests working when Redis lookups timed out.
3. **Fastify beats Express by 38–42%** on an empty endpoint, **25%** on a realistic one: the gap shrinks with real work.
4. **Scale out JavaScript, scale up thread-pool work:** 2 × 1 CPU beat 1 × 2 CPUs for DB reads (1.80× vs 1.46×);
   1 × 4 CPUs beat 4 × 1 CPU for logins (~4.7× vs 3.0–3.7×), explained by CPU throttling.
