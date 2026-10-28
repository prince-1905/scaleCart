# Interview notes — Phase 2: Caching, frameworks, scaling (and a mystery solved)

Evidence for every number below: [E2 experiment report](../experiments/E2-cache-adapters-scaling.md).
Measured on my laptop (Docker Desktop, API limited to 1 CPU unless stated).

---

## 1. The 30-second version

> "Phase 2 was about making ScaleCart faster and finding real bottlenecks. First I solved a mystery from
> Phase 1: 504 errors during a 2,000-request burst. I proved with a kernel counter that Node's connection
> queue, 511 places by default, was overflowing: 4,322 dropped attempts. Raising it to 4,096 took errors to zero.
> Then I added a Redis cache for product pages: 1.6–2× more throughput and **95–97% fewer database reads**.
> Fastify beat Express by 40% on an empty endpoint but only 25% on a real one. And scaling taught me
> that *where the work runs* decides how to scale: database reads scale by adding processes, but password
> hashing scales by adding cores to one process."

---

## 2. Key concepts, in plain English

| Term | Meaning | Analogy |
|---|---|---|
| **Cache-aside** | Look in the cache first; on a miss, read the DB and save a copy | Check your notes before going to the library |
| **Hit ratio** | Share of lookups the cache could answer | How often your notes had the answer |
| **TTL** | How long a cached copy lives before it expires | Milk's expiry date |
| **Invalidation** | Deleting the cached copy when the real data changes | Crossing out an old note when the book changes |
| **Cache stampede** | A popular entry expires and hundreds of requests hit the DB at once | Everyone runs to the library at the same moment |
| **Request coalescing** | Only the first request loads; the others wait for its answer | One person goes to the library and shares the answer |
| **Fail open** | If the cache is down, carry on without it (slower, still working) | Library open even when your notes are lost |
| **Listen backlog** | The kernel's waiting line of new connections Node hasn't picked up yet | The queue outside a shop's door |
| **Scale up / vertical** | Give one process more CPU | A faster chef |
| **Scale out / horizontal** | Run more copies of the process | More chefs |
| **Thread pool** | A few helper threads Node uses for heavy native work (Argon2, files, DNS) | Kitchen helpers working next to the chef |

---

## 3. The stories (problem → proof → fix → trade-off)

### Story A — "How did you debug the 504 errors?" ⭐ (shows a debugging method)
- **Symptom:** 2,000 checkout requests at once → hundreds of 504s from NGINX, but no errors in the app logs.
- **Clue:** NGINX logged "timed out while *connecting* to upstream". So the requests never reached the app.
- **Hypothesis:** new connections wait in a kernel queue until Node accepts them. Node asks for only
  **511** places by default; the kernel would allow 4,096.
- **Proof:** the kernel counter `ListenOverflows` jumped by **4,322** during the burst.
- **Fix:** backlog 4,096. Result: **0 overflows, 0 errors, 1,000 of 1,000 buyers served** (twice).
- **Honest trade-off:** errors became *waiting*. p99 rose to 7–27 s, because 1 CPU can only do so many checkouts.
  The real answer for a flash sale is a **waiting room**: let people in at the rate you can serve, or shed load with a fast 503.
- **Lesson to say out loud:** "I don't change settings on a hunch. I found a counter that proves the cause,
  then checked the same counter went to zero after the fix."

### Story B — "Did you add caching? What did it buy you?" ⭐
- **What:** product pages are cached in Redis for ~60 s (cache-aside). On a miss: read MySQL, save a copy.
- **Proof (hot set of 1,000 products, 1 CPU):**
  - Throughput **1,486 → 2,435–3,081 req/s (1.6–2.1×)**.
  - **MySQL reads −95 to −97%** (146,615 → 4,476–6,802 queries for the same test), with a 93–96% hit ratio.
- **Why not 10× faster?** The API itself is the bottleneck (event loop 100% busy). A cache hit still costs
  a Redis round trip, JSON parsing and the framework. **The big win is protecting the database.**
- **When it doesn't help:** reads spread over all 200,000 products → **22% hit ratio**, ~no gain.
  A cache only helps when the same things are read again and again.

### Story C — "How do you keep the cache correct?"
- **Writes:** update MySQL first, then **delete** the cached copy. The next read loads the new value.
  (Deleting is safer than updating the cache: two writers can't leave the cache with the older value.)
- **TTL as a safety net:** even if something goes wrong, a stale copy dies within ~60 s.
- **Money never comes from the cache.** Cart totals and checkout read prices from MySQL. A product page may be
  a few seconds stale; the amount we charge must not be.
- **Stampede protection:** request coalescing. When a hot product isn't cached, only one request reads MySQL.
  We saw ~5,000 requests per run wait for someone else's load instead of hitting the DB.
- **TTL jitter (±10%):** keys cached together don't all expire together.
- **"Not found" is cached too** (10 s), so bots asking for random ids can't hammer MySQL.

### Story D — "What happens if Redis goes down?"
- **Fail open:** every Redis call has a 200 ms limit. If Redis is down or slow, the app skips it and reads MySQL.
  A test proves login, product pages and checkout all work with Redis off.
- Nothing important lives only in Redis: stock, orders, carts and idempotency keys are in MySQL.
- Seen in the experiment: during overload, 2k–5k lookups per run timed out, mostly because our *own* event loop
  was busy. They fell back to MySQL instead of failing.
- **Trade-off:** with Redis down, all the load lands on MySQL. If MySQL can't take it, add rate limits or a
  second cache tier (in-process memory).

### Story E — "How do you stop password guessing?"
- After **5 failed logins for one email within 15 minutes → 429** "too many failed logins".
- The counter is in Redis, so **all API copies share it**.
- The check runs **before** the expensive Argon2 hash, so blocked guesses cost ~nothing. (One login = ~30 ms CPU;
  a guessing flood is also a CPU attack.)
- **Trade-offs:** an attacker can lock a real user out for 15 min, the classic lockout problem. Fails open if
  Redis is down. Next step: per-IP limits (needs the real client IP from the load balancer).

### Story F — "Fastify or Express?"
- Same app, only the HTTP layer swapped, two rounds each.
- Empty endpoint: Fastify **+38–42%**. Real endpoint (cached product): **+25%**.
- **Lesson:** framework speed is a fixed per-request cost. The more real work a request does, the less it matters.
  Caching and query shape matter more than the framework.

### Story G — "Scale up or scale out?" ⭐ (the most senior-sounding one)
- **Database reads (JavaScript on the event loop):**
  1 CPU 1,363 → **4 CPUs on one process: 2,101 (+54%)**. It used at most 1.54 cores, because one process = one JS thread.
  **2 processes × 1 CPU: 2,455 (1.8×)** with half the CPUs. → *Scale out.*
- **Login (Argon2 on Node's 4-thread pool):**
  **1 process × 4 CPUs: ~100 logins/s (4.7×)** vs **4 processes × 1 CPU: 63–77/s**.
  Each 1-CPU process runs 4 hashing threads on a 1-CPU budget and gets throttled: **3.8 s paused per second of CPU
  used**, versus 0.1 s with 4 CPUs. → *Scale up, up to the pool size.*
- **One-liner:** "Find where the work runs. JavaScript work → more processes. Native thread-pool work → more cores
  per process, matched to `UV_THREADPOOL_SIZE`."
- **Honest limit:** 4 processes stopped at ~3k req/s with my laptop at 96% CPU, so I'd re-measure on real cloud machines.

---

## 4. Likely follow-up questions

**Q: Why Redis and not an in-process cache (a Map in memory)?**
An in-process cache is faster (no network) but each copy has its own, so 4 replicas = 4 different caches
and invalidation must reach all of them. Redis is shared. Many systems use both: tiny in-process + Redis.

**Q: Why is the TTL 60 s?**
Product names and descriptions change rarely, and writes delete the key anyway. TTL is only the safety net.
Shorter = fresher but more DB reads; longer = staler but cheaper.

**Q: Write-through vs cache-aside?**
Write-through writes cache and DB together on every write. Cache-aside fills the cache lazily on reads.
Cache-aside only caches what's actually read, and a cache failure never blocks a write.

**Q: What's `allkeys-lru`?**
When Redis is full (256 MB here), it evicts the least-recently-used keys. Right for a cache: old entries
just get reloaded from MySQL.

**Q: Why not just set the backlog to 100,000?**
The kernel caps it at `somaxconn` (4,096 here). And a bigger queue isn't free: those requests still wait,
and we saw p99 reach 27 s. Past a point, rejecting fast is kinder than queueing.

**Q: Why does 4 CPUs barely help a Node process?**
JavaScript runs on one thread. Extra cores only help Node's helper threads (GC, thread pool). For
JavaScript-heavy work, run more processes (containers, or Node's `cluster` module).

**Q: Why did 4 small containers do worse for login than 1 big one?**
CPU quotas. Each 1-CPU container has 4 hashing threads that burst together, use up the quota in part of
each 100 ms period, and get paused for the rest. One 4-CPU container gives each thread its own core.

**Q: What's Swagger for?**
An auto-generated API page at `/docs`: every endpoint, its inputs, and a "Try it" button. It's generated
from the code, so it doesn't go out of date.

---

## 5. Self-quiz (answer out loud, then check above)

1. NGINX returned 504 but the app logged nothing. What did you check, and what number proved the cause?
2. The cache made the API only ~2× faster. Why was it still worth it?
3. An admin changes a price. What happens to the cached product, and why delete instead of update?
4. Redis crashes during a sale. What do customers notice?
5. Why does the login limit run *before* the password check?
6. You have 4 CPUs. How do you deploy the API for product reads? And for login? Why differently?

<details><summary>Answers</summary>

1. NGINX said "timed out while *connecting*", so requests never reached Node. The kernel counter
   `ListenOverflows` rose by 4,322 during the burst: Node's 511-place accept queue overflowed. With 4,096: 0.
2. MySQL reads dropped 95–97%. The database is the hardest part to scale and is needed for checkout.
3. MySQL is updated first, then the Redis copy is deleted; the next read loads the new price. Deleting can't
   leave an older value behind when two writes race, and a TTL limits any leftover staleness to ~60 s.
4. Almost nothing: requests fall back to MySQL after at most 200 ms (fail open). Product pages get slower and
   MySQL gets busier. Login limits stop working until Redis returns.
5. So a blocked guess costs no Argon2 CPU (~30 ms each), which protects the server from guessing floods.
6. Product reads (event-loop-bound): 4 processes × 1 CPU (scale out: 1.8× from 2 processes vs 1.46× from 2 CPUs).
   Login (thread-pool-bound): fewer processes with ~4 CPUs each (4.7× vs 3.0–3.7×), because small CPU quotas
   throttle the 4 hashing threads.
</details>
