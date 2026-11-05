# E7 — Kubernetes on the laptop: rolling updates, autoscaling, database connections

**Date:** 2026-11-04 · **Phase:** 7-light · **Status:** done (ProxySQL left for later)

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H, 15.7 GB RAM, Windows 11, Docker Desktop (WSL2 ≈ 7.6 GB). The Compose stack was stopped to free memory |
| Cluster | **kind v0.33.0**, one node; kubectl v1.32.2 (Docker Desktop's); metrics-server **v0.9.1** (`k8s/addons/`, `--kubelet-insecure-tls`) |
| App | `k8s/*.yaml`, started with `k8s/up.ps1`: MySQL 8.4.13 + RabbitMQ (StatefulSets with volumes), Redis, Mailpit, migrate + seed Jobs, API and worker Deployments. API pods: request 500m / limit 1 CPU, 256–512 Mi |
| Entry | NodePort 30080 → `http://localhost:8089` (kube-proxy, so balancing is **per connection**) |
| Probes | startup + liveness `/health/live` (checks nothing external), readiness `/health/ready` (pings the module databases) |
| Load | k6 from the host. E7a: `e7-rollout.js` · E7b: `e7-autoscale.js` · E7c: `e5-drop.js MODE=direct STOCK=1000` |
| Raw data | `load-tests/results/e7*-<run-id>.*` (not committed) |

---

## E7a — Do customers notice a rolling update?

`GET /products/:id` at **200/s for 60 s** against 2 API pods; at T+20 s, `kubectl rollout restart deployment/api` (one new pod
ready before an old one stops). Failed = anything but 200.

| How a pod stops | Failed requests per restart (each run ~12,000 requests) |
|---|---|
| **Nothing** (SIGTERM → Nest closes at once) | **27, 62, 67, 50, 55** (EOF = connection cut, 10 s timeouts, one 503) |
| `preStop: sleep 5` only | 65, 0, 0, 0 · 1, 0, 0 · 0, 0 |
| **Graceful drain** (with or without preStop) | **0, 0, 0, 0, 0, 0** |

- **Why "nothing" fails:** Kubernetes removes a stopping pod from the Service *and* sends SIGTERM at the same time. Requests
  still on their way, or on already-open keep-alive connections, hit a closing server.
- **Why `preStop: sleep 5` is not enough:** it stops *new* connections reaching the pod, but clients (here k6, in
  production NGINX or browsers) keep sending on connections they already hold. The 65-failure run had 26 × **503
  from Fastify** (its default answer while closing) and 39 timeouts.
- **Fix: graceful drain** (`src/common/graceful-drain.ts`). On SIGTERM, the pod keeps serving for
  `SHUTDOWN_DRAIN_SECONDS` (5), but every answer says **`Connection: close`** and `/health/ready` says 503. Clients hang up
  after their current request and reconnect, which lands them on a live pod. Then the app closes (hooks, sockets).
  Tested on Fastify and Express (`app.e2e-spec.ts`).
- A first series was discarded: the "no preStop" patch silently didn't apply (PowerShell quoting), so all 4 runs were the
  same setup. Fixed with a patch file, verified by a dry run. The "no drain" switch was verified by `printenv` in a pod.

## E7b — Autoscaling (HPA): do new pods actually get traffic?

HPA: target **60% of the 500m request**, 1–4 pods, scale up 2 pods/15 s, scale down after 2 min of calm. Load: 100/s →
ramp to **1,500/s** → hold 3 min → 100/s for 3 min. Per-pod CPU from `kubectl top`, every 5 s.

| Run | Pods reached | CPU per pod during the peak (millicores) | Failed | p95 |
|---|---|---|---|---|
| no connection limit `e7b-hpa-…154552` | 3 (never 4) | **600–726** / 33–115 / 72–111 | 0 | 8.9 ms |
| no connection limit `e7b-noreconnect-…182251` | 4 | **702–758** / 267–304 / 81–114 / 12–62 | 0 | 105.5 ms |
| **limit 500 req/connection** `e7b-reconnect500-…155614` | 3 | **144–353 / 242–461 / 118–337** | 0 | 3.7 ms |
| **limit 500 req/connection** `e7b-reconnect500-…183125` | 4 | **204–299 on each** | 0 | 6.3 ms |

- **The trap:** kube-proxy picks a pod **per connection, not per request**. k6 opened its connections at the start, all to
  pod 1, and kept reusing them. New pods only got the few *new* connections, so pod 1 did ~80% of the work.
- **The HPA was fooled by the average.** At 52–58% average CPU it never added the 4th pod in the first run, while pod 1
  was at ~140% of its request. During scale-down it even removed the busiest pod first.
- **Fix:** `server.maxRequestsPerSocket = HTTP_MAX_REQUESTS_PER_SOCKET` (500 in Kubernetes). After 500 requests, Node
  answers `Connection: close`, the client reconnects, and kube-proxy spreads the new connections. New pods got their
  share ~15–50 s after becoming ready. A request-level (L7) load balancer, like an Ingress, would also fix it.
- **Scale-up:** the 2nd pod existed 15–53 s after the ramp began, the last one after 58–119 s (metrics are scraped
  every 15 s, and the HPA needs a reading first). **Scale-down:** 3→2→1 about 2.2–2.7 min after the load dropped (the
  2 min calm window).
- **Customers were fine in all runs** (0 failed): at 1,500/s of cached reads one pod copes. The scale-out buys headroom.
  "Dropped iterations" (k6 couldn't start a request on time) were 10–5,744, too noisy to compare.
- **One run was invalid:** the laptop went into Modern Standby (Windows event 507, woke at 18:18). The watch log stopped
  and one request "took" 333 s with a 10 s timeout. It was rerun after the wake.

## E7c — Database connections: one more pod, and checkout falls over

1,000 buyers check out at once (stock 1,000), fixed pod count, MySQL `max_connections = 151`. Each API pod has **7 module
pools** (one database per module) of `DB_POOL_SIZE` connections.

| Pods × pool | Peak connections | Orders created | Checkout errors | Queue errors (retried) | Checkout p50 / p95 |
|---|---|---|---|---|---|
| 4 × 5 | 136 / 131 (2 runs) | 1,000 / 1,000 | 0 / 0 | 8 / 17 × 503 | 4,712 / 7,542 · 3,830 / 6,866 ms |
| **5 × 5** | **152 (limit)**, **830 refused** | **239** | **761 × 500** | 4 × 503 | 25,959 / 27,048 ms |
| 5 × 2 | 72 / 75 | 1,000 / 1,000 | 0 / 0 | 1 × 503 / 11 × 503 + 2 × 500 | 4,842 / 8,220 · 4,645 / 7,107 ms |
| 4 × 2 | 61 / 61 / 61 | 1,000 × 3 | 0 | 1 / 2 / 10 × 503 | 15,112 ⚠ / 4,686 / 4,185 ms (p50) |

Queue 503 = "waiting room unavailable": the Redis call missed its 200 ms limit on a busy pod (as in E5).

- **The cliff:** 4 pods peaked at 90% of the limit, so one more pod (which the HPA would add in a busy moment) made MySQL
  refuse connections. 761 of 1,000 checkouts failed with 500. The pods logged `Unable to connect to the database (cart) …
  Too many connections`. It even started during the rollout itself: old and new pods overlapping cost 40 refusals before
  any load.
- **The cause is the design:** a database per module (chosen so the later microservice split is cheap) multiplies
  connections: pods × 7 × pool size.
- **Fix now: a connection budget.** `DB_POOL_SIZE` 5 → 2 in Kubernetes. Rule: `max pods × 7 × pool + worker < max_connections
  − spare`. Five pods then peak at 72–75 connections, and checkout speed stays within this laptop's ±25% noise.
  ⚠ One 4 × 2 run was 3× slower, but two reruns with disk stats weren't, so I treat it as an outlier.
- **Remaining issue:** in the 5 × 2 rerun, 2 waiting-room calls got 500 (`connect ETIMEDOUT` while pools opened new
  connections during the rush). `POST /drops/:id/queue` reads the drop from MySQL on every call; a short cache would
  remove that. Not done yet.
- **Next step (decided, not built): ProxySQL.** Many app connections share a few MySQL ones, so pods can grow without the
  budget shrinking. Caveat for MySQL 8.4's `caching_sha2_password`: SSL from the app to ProxySQL and cleartext passwords
  in ProxySQL's config.

## Setup findings

- **RabbitMQ's first start on a new volume crashed** (`.erlang.cookie: eacces`), then worked on the automatic restart. The
  image runs as uid 100 / gid 101; `securityContext { runAsUser: 100, runAsGroup: 101, fsGroup: 101 }` fixed it (fresh
  volume: 0 restarts). The worker reconnected by itself both times.
- **ConfigMap or image changes only reach pods that restart.** One E7b attempt ran on old pods and was stopped; the run
  scripts now always `rollout restart` first.
- **PowerShell 5.1 traps:**
  - kind's "No kind clusters found." on stderr counted as a failure.
  - `--` is swallowed when passed through a function's `@args`, so `kubectl exec … -- printenv` printed nothing.
  - JSON in `-p '…'` loses its quotes, so use `--patch-file`.
