# Interview notes — Phase 7-light: Kubernetes (probes, rolling updates, autoscaling, connections)

Evidence: [E7 experiment report](../experiments/E7-kubernetes.md). Local cluster: kind (Kubernetes in Docker), one node.

---

## 1. The 30-second version

> "I moved ScaleCart onto Kubernetes and tested three things a real deployment hits. **Rolling updates:** with no
> shutdown handling, each restart failed 27–67 requests at 200/s. A preStop sleep wasn't enough, because keep-alive
> connections still reached the closing pod. With a graceful drain (keep serving with `Connection: close`, then close) it
> was **0 in 6 out of 6 runs**. **Autoscaling:** the HPA added pods, but they sat idle, because the Service balances
> *connections*, not requests. Recycling connections after 500 requests spread the load evenly. **Database connections:**
> one database per module means each pod holds up to 35 MySQL connections. 4 pods were at 90% of the limit, and the 5th
> pod made **761 of 1,000 checkouts fail**. A connection budget fixed it; ProxySQL is the next step."

---

## 2. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Pod / Deployment** | A running copy of the app / the rule "keep N copies running" | A worker / the shift plan |
| **Service** | One stable address that spreads traffic over the pods | The shop's front door |
| **Liveness probe** | "Is it stuck? Restart it" (checks nothing external) | Checking a worker is awake |
| **Readiness probe** | "Should it get customers?" (checks its databases) | Is the counter open |
| **Rolling update** | Replace pods one by one, new ready before old stops | Changing shifts without closing the shop |
| **SIGTERM / graceful shutdown** | "Please stop": finish what you're doing, then exit | Last orders, then lock the door |
| **Drain** | Keep serving, but tell each client to reconnect elsewhere | "Please use the next counter" |
| **HPA** | Adds or removes pods based on CPU | Calling in extra staff when the queue grows |
| **Keep-alive** | Reusing one connection for many requests | Staying on the phone instead of redialling |
| **Connection pool** | A few reusable DB connections per process | A taxi rank instead of a taxi per trip |

---

## 3. The stories

### Story A — "Zero-downtime deploys: the preStop sleep isn't enough" ⭐
- **Problem:** on SIGTERM Kubernetes also removes the pod from the Service, but not instantly, and clients keep using
  connections they already hold. **Measured:** 27, 62, 67, 50 and 55 failed requests per restart (EOF, timeouts).
- **First fix:** `preStop: sleep 5` (stop *new* traffic before shutting down). Usually 0–1 failures, but one run had **65**:
  26 × 503 from Fastify's "closing" answer, and 39 timeouts, all on old keep-alive connections.
- **Real fix:** **drain.** On SIGTERM, keep serving for 5 s, add `Connection: close` to every response, and make readiness
  answer 503. Each client finishes its request and reconnects to a live pod. Then close. **0 failures in 6 of 6 runs.**
- **Liveness vs readiness:** liveness checks nothing external, on purpose. If it pinged MySQL, a database blip would
  make Kubernetes restart *every* pod at once.

### Story B — "My autoscaler added pods… that did nothing" ⭐
- **Proof:** at 1,500 req/s the HPA went 1 → 3–4 pods, but pod 1 ran at 600–758 millicores while the new ones ran at
  12–115.
- **Why:** a Kubernetes Service (kube-proxy) chooses a pod **when a connection opens**. The load generator kept its
  connections, so the new pods only got new connections. The HPA looks at **average** CPU, which looked fine (52–58%),
  while one pod was hot. It even removed the busiest pod when scaling down.
- **Fix:** close each connection after 500 requests (`server.maxRequestsPerSocket`). Clients reconnect and spread out:
  **204–299m on each of 4 pods**, p95 3.7–6.3 ms (vs 8.9–105.5 ms).
- **Alternatives:** an L7 load balancer (Ingress/NGINX, a service mesh) balances per request; or gRPC-style client-side
  balancing.

### Story C — "Scaling out the app knocked over the database" ⭐
- **Design cost:** one database per module (for an easy future split) means 7 pools per pod. At pool size 5, that's up to
  35 connections per pod.
- **Proof:** 4 pods → 136 of 151 MySQL connections. **5 pods → limit reached, 830 refused, 761 of 1,000 checkouts failed
  (500)**, p50 26 s. It even happened during a rollout, when old and new pods overlap.
- **Fix now:** a budget: `max pods × 7 × pool + worker < max_connections − spare`. Pool 5 → 2: 5 pods peak at 72–75,
  1,000/1,000 orders, about the same speed.
- **Next:** ProxySQL, so app connections share fewer MySQL connections; or raise `max_connections` (each connection costs
  memory); or fewer pools per pod (merge modules on one server).

### Story D — "Things that went wrong in the lab" (debugging credibility)
- **RabbitMQ crashed once on a new volume** (`.erlang.cookie` permission) → fixed with the `fsGroup` / `runAsUser` of the
  image.
- **Changed config, but the pods didn't:** ConfigMaps and new images only reach pods that restart.
- **The laptop went to sleep mid-test:** a "request" took 333 s with a 10 s timeout → the run was thrown out (Windows event
  507) and rerun.

---

## 4. Likely follow-up questions

**Q: Why requests and limits, and what is the HPA's 60%?**
The request is what the scheduler reserves (500m); the limit is the cap (1 CPU). The HPA's target is a percentage of the
*request*, so 60% ≈ 0.3 core per pod.

**Q: Why does scale-down wait 2 minutes?**
To avoid flapping: add, remove, add. Scale-up reacts at once (2 pods per 15 s). Our measured scale-up: 2nd pod 15–53 s after
the ramp began, the last one after 58–119 s, because metrics arrive every 15 s.

**Q: Why are MySQL and RabbitMQ StatefulSets?**
A stable name (`mysql-0`, `rabbitmq-0`) and their own disk that survives restarts. RabbitMQ stores data per node name.

**Q: Where do secrets come from?**
A Kubernetes Secret created by `k8s/up.ps1` from the git-ignored `.env`, via a temp file that's deleted, never committed. In
production: a secret manager (Vault, cloud KMS, External Secrets).

---

## 5. Self-quiz

1. Why can a rolling update fail requests even with readiness probes?
2. What does the drain do that `preStop: sleep` doesn't?
3. Why did new pods get no traffic, and what fixed it?
4. Why did the 5th pod break checkout? Give the formula.
5. Why must liveness not check the database?

<details><summary>Answers</summary>

1. Removal from the Service and SIGTERM happen at the same time, and clients keep using already-open connections to the
   old pod.
2. It tells clients to leave (`Connection: close` on every response while still serving), so open keep-alive connections
   move before the server closes.
3. The Service balances per connection, and the load generator reused its old connections to pod 1. Fix:
   `maxRequestsPerSocket` = 500, so clients reconnect regularly (or use an L7 balancer).
4. pods × 7 module pools × 5 = 175 + worker > 151 `max_connections` → MySQL refused new connections. Budget: pods × 7 ×
   pool + worker < limit − spare (pool 2 → 75 at 5 pods).
5. A database blip would fail liveness on every pod, and Kubernetes would restart all of them at once: an outage caused
   by the health check.
</details>
