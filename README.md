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
| 1 | Shop core: auth, catalog, cart, checkout (modular monolith) | ✅ done |
| 2 | Redis cache, login limits, Swagger, runtime experiments (Fastify vs Express, scaling) | ✅ done |
| 3 | RabbitMQ, transactional outbox, notification worker | next |
| 4 | Payment simulator, idempotency, saga | |
| 7-light | Kubernetes (kind), HPA, connection pooling | |
| later | 2FA · microservice split · tracing · cloud capacity tests · polish | |

## Results so far

- [E0 — test-rig calibration and the Node.js event loop](docs/experiments/E0-calibration-and-event-loop.md):
  one Node process (1 CPU) ≈ **4.3k req/s** trivial, **2.7k** with a 50 ms async wait, **~150** with 5 ms
  CPU work; a CPU-heavy endpoint made an unrelated endpoint's **p99 4× worse**.
- [E1 — overselling, idempotency, login cost, query patterns](docs/experiments/E1-checkout-auth-and-queries.md):
  a read-then-write stock check sold **~5× the stock** (474–499 orders for 100 units); one conditional
  UPDATE sold exactly 100 in every run. **0 duplicate orders** from 3,000 double-clicked requests.
  Login ≈ **22/s per CPU** (~60× costlier than a product read) and made other endpoints' p99 **8–11× worse**
  via CPU throttling. Keyset pagination: **1 ms vs 70 ms** for deep pages.
- [E2 — accept-queue fix, Redis cache, Fastify vs Express, scaling](docs/experiments/E2-cache-adapters-scaling.md):
  burst 504s traced to Node's 511-place accept queue (**4,322 overflows → 0**, 1,000/1,000 buyers served).
  Redis cache-aside: **1.6–2.1× throughput, 95–97% fewer MySQL reads** on popular products. Fastify vs Express:
  **+40%** empty endpoint, **+25%** real one. DB reads scale **out** (2×1 CPU: 1.8×) but logins scale **up**
  (1×4 CPUs: 4.7× vs 4×1 CPU: 3.0–3.7×, explained by CPU throttling).

How the whole app works, step by step (no code): [docs/scalecart-workflow.md](docs/scalecart-workflow.md)
Interview notes per phase: [docs/interview-notes/](docs/interview-notes/)

## Run it

Requires Docker Desktop, Node 24, and k6.

```powershell
Copy-Item .env.example .env           # then put your own passwords/secrets in .env (never committed)
docker compose up -d --build          # mysql, redis, migrate job, api, nginx, prometheus, grafana
# demo + load-test data: admin@scalecart.local (password = ADMIN_PASSWORD in .env),
# loadtest+1..2000@scalecart.local (password = SEED_USER_PASSWORD in .env)
docker compose run --rm -e SEED_PRODUCTS=200000 -e SEED_USERS=2000 migrate node dist/seed.js
curl http://localhost:8088/products?q=leather%20boot
```

| URL | What |
|---|---|
| http://localhost:8088 | API via NGINX load balancer |
| http://localhost:3001 | Grafana dashboard ("ScaleCart - Overview") |
| http://localhost:9090 | Prometheus |
| localhost:6379 | Redis (cache + login-failure counters; optional, the API works without it) |
| localhost:3307 | MySQL (user `scalecart`, password `DB_PASSWORD` from .env; one database per module: `scalecart_identity`, `_catalog`, `_inventory`, `_cart`, `_orders`) |

### API

Try every endpoint in the browser: **http://localhost:8088/docs** (Swagger). Log in with `POST /auth/login`,
click **Authorize**, paste the `accessToken`.

| Endpoint | Auth | What |
|---|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` | – | JWT access token (15 min) + rotating refresh token |
| `GET /auth/me` | user | Current user |
| `GET /products?q=&after=&limit=`, `GET /products/:id` | – | FULLTEXT search, keyset pagination |
| `POST /products` · `PATCH /products/:id` | admin | Create / update product (update clears the cached copy) |
| `GET /inventory/:productId` · `PUT /inventory/:productId` | – · admin | Stock |
| `GET /cart` · `PUT /cart/items/:productId` · `DELETE /cart` | user | Cart (prices always from the catalog) |
| `POST /checkout` (header `Idempotency-Key`) | user | Cart → order; can't oversell, can't double-order |
| `GET /orders?before=&limit=`, `GET /orders/:id` | user | Own orders |

### Tests

```powershell
cd apps/api
npm test              # unit tests
npm run test:e2e      # needs `docker compose up -d mysql redis`; uses scalecart_test_* databases + Redis db 1
```

### Experiments

Each run prints a per-step table and checks the load generator wasn't the bottleneck:

```powershell
./load-tests/run.ps1 -Script e0-calibration.js
./load-tests/run.ps1 -Script e0-event-loop.js -K6Env PART=cpu
./load-tests/run.ps1 -Script e1-flash-sale.js                       # 1,000 buyers, 100 units
$env:STOCK_RESERVATION='naive'; docker compose up -d --wait api; docker compose restart lb   # then re-run to see overselling
./load-tests/run.ps1 -Script e1-login-and-catalog.js -K6Env PART=login
cd apps/api; node scripts/e1-queries.ts                             # search + pagination inside MySQL
```

Useful knobs: `API_REPLICAS`, `API_CPUS`, `HTTP_ADAPTER=fastify|express`, `CACHE_ENABLED`, `HTTP_LISTEN_BACKLOG`,
`STOCK_RESERVATION=atomic|locking|naive`, `DB_POOL_SIZE`, `LB_PORT` (default 8088). After recreating the API container, restart `lb` so NGINX re-resolves it.

## Layout

```
apps/api/            NestJS application: one folder per module (identity, catalog, inventory, cart, orders)
infra/               mysql init, nginx, prometheus, grafana (dashboards provisioned automatically)
load-tests/          k6 scripts, runner, report generator
docs/experiments/    experiment write-ups with real numbers
docs/interview-notes/ how to explain each phase
```
