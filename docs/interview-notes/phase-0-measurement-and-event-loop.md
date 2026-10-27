# Interview notes — Phase 0: Measuring performance & the Node.js event loop

Evidence for every number below: [E0 experiment report](../experiments/E0-calibration-and-event-loop.md).
All numbers were measured on my laptop (i7-12650H, Docker Desktop, app limited to 1 CPU).

---

## 1. The 30-second version

> "Before building features I built the measurement setup: Prometheus and Grafana for server metrics, k6 for
> load, and a check that the load generator itself isn't the bottleneck. Then I measured one Node.js process.
> It handled about 4,300 trivial requests per second, but only about 150 per second when each request did
> 5 ms of CPU work, while a request that *waited* 50 ms without blocking still ran at about 2,700 per second.
> Throughput depends on CPU per request, not on wait time. I also showed head-of-line blocking: a CPU-heavy
> endpoint made an unrelated endpoint's p99 four times worse."

---

## 2. Key concepts, in plain English

| Term | Meaning | Why it matters |
|---|---|---|
| **RPS / throughput** | Requests completed per second | Capacity |
| **Latency** | Time for one request | User experience |
| **p50 / p95 / p99** | 50% / 95% / 99% of requests were faster than this | Averages hide the slow tail; p99 is what your unluckiest users feel |
| **Concurrency (in-flight)** | Requests being processed right now | **Little's law: in-flight = RPS × latency.** 2,000 rps × 50 ms = 100 in flight |
| **Open model** | Load tool sends N req/s no matter how slow the server is | Like real users. What I used. |
| **Closed model** | Fixed users, each waits for a reply before the next request | Slows down *with* the server, so it hides overload ("coordinated omission") |
| **Saturation / knee** | The point where latency starts rising sharply | The real capacity is *before* the knee, not at max throughput |
| **Event loop** | Node runs JavaScript on **one thread** that takes turns between tasks | Waiting is free; computing blocks everyone |
| **Event-loop utilization (ELU)** | Fraction of time that thread was busy | ~1.0 = this process is saturated, even if the machine has idle cores |
| **CPU throttling** | Container used its CPU quota, so the kernel pauses it | Shows up as latency spikes, not "slower CPU" |

---

## 3. The stories (problem → proof → explanation → fix)

### Story A — "How do you know your load test is valid?"
- **Problem:** if the load generator is overloaded, you are measuring the laptop, not the app.
- **Proof:** I measured an NGINX endpoint that never touches Node. The rig handled **~8,000 req/s** cleanly;
  at 16,000 the host CPU hit **94.5%** and k6 dropped requests.
- **Rule I follow:** each run records k6's CPU, host CPU and `dropped_iterations`. App results only count
  when they are well below the rig's ceiling. My app maxed at ~4.3k, about half the rig's 8k, so the result was valid.

### Story B — "Is Node.js single-threaded? Can it handle many users?"
- JavaScript runs on one thread, but I/O (network, DB, timers) doesn't block it.
- **Proof:** with a 50 ms non-blocking wait, one process served **~2,000 req/s with latency still ≈ 50 ms**,
  with ~100 requests waiting at the same time. Peak in-flight in that run: **717**.
- With **5 ms of CPU work** instead, the same process managed only **~150 req/s**.
- **Takeaway:** Node is great for I/O-heavy services. CPU-heavy work (password hashing, image processing,
  big JSON) needs worker threads, a separate service, or more processes.

### Story C — "What happens when a server is overloaded?"
- **Proof:** at 5,000 req/s against a ~4,300 req/s process, median latency went from **~2 ms to 147 ms**,
  p99 to **2.5 s**, and **6% of requests failed with HTTP 504**.
- **Why 504?** The app never errored. Requests **queued** inside the process for over 30 s, and NGINX's
  timeout gave up. Overload = an invisible queue that keeps growing.
- **Fix (coming in later phases):** load shedding (reject fast with 503 when the event loop is overloaded),
  timeouts shorter than the user's patience, rate limiting, and autoscaling. "Fail fast" beats "fail after 30 s".

### Story D — "One slow endpoint slowed down everything"
- **Proof:** `/lab/ping` does no work. Alone, its p99 was **8.0 ms**. With CPU-heavy requests (5 ms each,
  only ~50% load) on the same process, its p99 became **31.9 ms (4× worse)**.
- **Why:** head-of-line blocking. A ping that arrives during a 5 ms computation must wait for it.
- **Fix:** isolate CPU work (worker threads or a separate service), or scale out processes.
  Relevant later: password hashing in login (Argon2) is CPU-heavy, so login gets its own analysis.

### Story E — "Why didn't you get the theoretical number?" (shows maturity)
- Theory: 5 ms per request → max **200 req/s** on one thread. I measured **~145–170**.
- The event loop showed **100% busy**, but the process only got **0.71–0.86 cores**. Throttling explained just
  3–4%; the rest was the thread waiting to be scheduled on a busy hybrid-core laptop inside a VM.
- **Lesson:** a Docker/Kubernetes CPU *limit* of 1 isn't a dedicated core. I'd confirm on dedicated cloud vCPUs.
- **Bonus:** my first version measured *wall-clock* time and reported an impossible ~220 req/s. The cgroup
  stats showed **590 throttled periods**, so I fixed the benchmark to measure CPU time. *Check the measurement before trusting the result.*

---

## 4. Likely follow-up questions

**Q: Why p99 and not average latency?**
Averages hide the tail. At 4,000 req/s my median was 2.8 ms but p99 was 246 ms. 1 in 100 users waited ~90× longer than typical.

**Q: Why an open-model load test?**
Real users don't wait for other users' slow responses before clicking. A closed model sends fewer requests
when the server slows down, which hides overload (coordinated omission).

**Q: How would you use all CPU cores with Node?**
Run several processes: Node's `cluster` module on one machine, or (my choice) more containers/pods behind a
load balancer. Each pod gets about 1 CPU, so the health checks and metrics of each event loop stay meaningful.

**Q: When would you use worker threads?**
Only for CPU-heavy JavaScript. Node's docs say they don't help much with I/O.

**Q: What does `x-instance` on every response do?**
It names the container that served the request, so when I scale to several replicas I can *prove* the
load balancer spreads traffic (Phase 2).

**Q: Why are liveness and readiness separate endpoints?**
Liveness = "process alive", which checks nothing external, so a DB outage never makes Kubernetes restart
every pod. Readiness = "send me traffic", which will check the DB and Redis later.

**Q: Why are access logs off during load tests?**
Logging every request costs CPU and I/O on the same event loop. Metrics are cheaper and aggregate better.

---

## 5. Self-quiz (answer out loud, then check above)

1. One Node process handles 2,700 req/s with a 50 ms wait but only 150 req/s with 5 ms of CPU. Why?
2. Little's law: 3,000 req/s at 40 ms latency, how many requests are in flight?
3. What does `dropped_iterations > 0` in k6 tell you?
4. Users got HTTP 504, but the app logged no errors. What happened?
5. ELU is 1.0 but the container uses only 0.8 of its 1 CPU. What's going on?
6. Why can a CPU limit make latency *spiky* instead of uniformly slower?

<details><summary>Answers</summary>

1. Waiting doesn't occupy the thread; computing does. Capacity ≈ 1 / (CPU time per request).
2. 3,000 × 0.04 = **120**.
3. k6 couldn't start requests on time (not enough VUs, or the generator is overloaded). That step's numbers are suspect.
4. Requests queued in the overloaded process longer than the proxy's timeout (30 s), and NGINX returned 504.
5. The thread wants to run but isn't getting CPU time: throttling and/or scheduler contention (shared host, VM).
6. The quota is enforced per 100 ms period. Use it up early and the container is paused for the rest of the period.
</details>
