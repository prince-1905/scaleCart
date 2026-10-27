# ScaleCart

An e-commerce backend with **flash-sale drops**, built to learn and *prove* system-design concepts with
measurements: load balancing, caching, queues, payments that never double-charge, autoscaling, and
graceful failure. Every performance claim in this repo links to a reproducible experiment.

**Stack:** Node.js 24 · TypeScript · NestJS 12 (Fastify) · MySQL + TypeORM · Redis · RabbitMQ · Docker ·
Kubernetes · Prometheus · Grafana · k6

## Status

| Phase | What | State |
|---|---|---|
| 0 | Measurement harness, event-loop experiments | ✅ done |
| 1 | Shop core: auth, catalog, cart, checkout (modular monolith) | next |
| 2 | Caching + runtime experiments (Fastify vs Express, CPU scaling) | |
| 3 | RabbitMQ, transactional outbox, notification worker | |
| 4 | Payment simulator, idempotency, saga | |
| 7-light | Kubernetes (kind), HPA, connection pooling | |
| later | 2FA · microservice split · tracing · cloud capacity tests · polish | |

## Results so far

- [E0 — test-rig calibration and the Node.js event loop](docs/experiments/E0-calibration-and-event-loop.md):
  one Node process (1 CPU) ≈ **4.3k req/s** trivial, **2.7k** with a 50 ms async wait, **~150** with 5 ms
  CPU work; a CPU-heavy endpoint made an unrelated endpoint's **p99 4× worse**.

Interview notes per phase: [docs/interview-notes/](docs/interview-notes/)

## Run it

Requires Docker Desktop, Node 24, and k6.

```powershell
docker compose up -d --build          # api + nginx + prometheus + grafana
curl http://localhost:8088/lab/ping   # through the load balancer
```

| URL | What |
|---|---|
| http://localhost:8088 | API via NGINX load balancer |
| http://localhost:3001 | Grafana dashboard ("ScaleCart - Overview") |
| http://localhost:9090 | Prometheus |

Run an experiment (prints a per-step table and checks the load generator wasn't the bottleneck):

```powershell
./load-tests/run.ps1 -Script e0-calibration.js
./load-tests/run.ps1 -Script e0-event-loop.js -K6Env PART=cpu
```

Useful knobs: `API_REPLICAS`, `API_CPUS`, `HTTP_ADAPTER=fastify|express`, `LB_PORT` (default 8088).

## Layout

```
apps/api/            NestJS application
infra/               nginx, prometheus, grafana (dashboards provisioned automatically)
load-tests/          k6 scripts, runner, report generator
docs/experiments/    experiment write-ups with real numbers
docs/interview-notes/ how to explain each phase
```
