# ScaleCart: how the whole app works (no code)

Read this top to bottom once. After that you should be able to draw the app on a whiteboard and walk
an interviewer through any request from start to finish.

---

## 1. Say this first (20 seconds)

> "ScaleCart is an online shop backend built for flash sales, where thousands of people try to buy
> a few items at the same moment. It handles login, product search, cart and checkout. The hard part I
> solved is that checkout **never sells more than we have** and **never creates two orders from one
> click**. I proved both with load tests: 1,000 buyers for 100 items gave exactly 100 orders."

---

## 2. The big picture: the boxes

```
   Customer / load test (k6)
            │  HTTP (port 8088)
            ▼
   ┌──────────────────┐
   │  NGINX           │   the front door: receives every request, passes it to the app
   │  (load balancer) │   (with several app copies, it spreads requests between them)
   └────────┬─────────┘
            ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  API  (Node.js + NestJS)          one app, 5 separate modules │
   │                                                               │
   │   identity    catalog    inventory    cart    orders          │
   └────┬────────────┬───────────┬───────────┬────────┬────────────┘
        │            │  ┌─────────────────────────┐
        │            └─►│ Redis (fast memory)      │  copies of product pages,
        └──────────────►│ OPTIONAL: app works      │  failed-login counters
                        │ without it, just slower  │
                        └─────────────────────────┘
        ▼            ▼           ▼           ▼        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  MySQL server, with 6 separate databases (one per module)     │
   │  identity · catalog · inventory · cart · orders · notifications│
   │  = the SOURCE OF TRUTH: anything important lives here         │
   └───────────────────────────────┬──────────────────────────────┘
                                   │ "outbox": notes saved with each order
                                   ▼
   ┌──────────────────┐     ┌──────────────┐     ┌──────────────────┐
   │ WORKER           │ ──► │ RabbitMQ     │ ──► │ WORKER           │ ──► Mailpit
   │ (relay: outbox → │     │ (message     │     │ (email sender)   │     (fake inbox)
   │  RabbitMQ)       │     │  queue)      │     │                  │
   └──────────────────┘     └──────────────┘     └──────────────────┘
     Same code as the API, separate program: does the slow work in the background.

   Prometheus ── every 5 s asks the API, the worker and RabbitMQ "how are you doing?"
   Grafana    ── draws those numbers as live charts
```

| Box | What it is, in one line | Where it runs |
|---|---|---|
| **NGINX** | Front door / traffic cop. Clients never talk to the app directly. | Docker, port 8088 |
| **API** | The actual shop logic. Node.js + NestJS framework + Fastify (fast web server). | Docker, limited to 1 CPU |
| **MySQL** | Where everything is stored permanently. | Docker, port 3307 |
| **Redis** | Super-fast memory store. Holds *copies* (cache) and counters, never anything we can't lose. | Docker, port 6379 |
| **Worker** | Background program: moves outbox notes to RabbitMQ, sends emails, runs cleanup jobs. Never talks to customers. | Docker, no public port |
| **RabbitMQ** | Message queue: a safe "order rail" that holds jobs until a worker takes them. | Docker, UI at port 15672 |
| **Mailpit** | Fake email server: catches every email so you can read it in the browser. | Docker, inbox at port 8025 |
| **migrate job** | Runs once at startup to create the databases and tables, then exits. | Docker |
| **Prometheus** | Collects performance numbers (speed, errors, CPU). | Docker, port 9090 |
| **Grafana** | Dashboard showing those numbers as charts. | Docker, port 3001 |
| **k6** | Load-testing tool: pretends to be thousands of users. | Your laptop |

Everything starts with one command: `docker compose up -d`.

---

## 3. What happens when you start the app

```
1. MySQL, Redis, RabbitMQ, Mailpit start
2. migrate job runs        → creates 6 databases + their tables, then stops
3. API starts              → opens connections to its 5 databases (5 connections each),
                              connects to Redis in the background (doesn't wait for it)
   Worker starts           → connects to RabbitMQ (keeps retrying until it can), creates
                              the queues, starts moving outbox notes and sending emails
4. NGINX starts            → begins accepting customer requests on port 8088
5. Prometheus + Grafana    → start watching the API, the worker and RabbitMQ
(6. seed script, run by hand → fills in demo data: 200,000 products, 2,000 test users, 1 admin)
```

**Why is migration a separate step?** If 4 copies of the app all tried to create tables at once, they
would trip over each other. One job does it first, and the app waits for it.

---

## 4. The 6 modules: who owns what data

Picture 6 departments in a shop. Each has **its own notebook**, and nobody writes in another
department's notebook. If one department needs something, it **asks** the other department.

| Module | Its job | What it stores (tables) |
|---|---|---|
| **identity** | Sign up, log in, who-are-you | `users`: email, **password hash** (never the real password), role (customer/admin) · `refresh_tokens`: **hash** of each refresh token, its expiry, used/revoked flags |
| **catalog** | Products and search | `products`: name, description, price **in cents**, SKU, plus a **search index** on name + description |
| **inventory** | How many items are left | `stock`: product → units available · `reservations`: "order X took 2 of product Y" (reserved / released) |
| **cart** | Each user's cart | `cart_items`: user, product, quantity (max 10 each, max 50 different products) |
| **orders** | Checkout and order history | `orders`: who, total, status · `order_items`: **copy** of name + price at the time of purchase · `idempotency_keys`: remembers each checkout attempt and its answer · `outbox`: "order.created" notes waiting to be sent to RabbitMQ |
| **notifications** | Confirmation emails (runs in the worker) | `sent_notifications`: which order events already got their email, so a repeat is skipped |

**What lives in RabbitMQ** (jobs in transit, stored on disk):

| Queue | What waits there |
|---|---|
| `notifications.order-created` | "send the confirmation email for order X" jobs |
| `….retry` | jobs that just failed: they wait 5 s, then go back to the main queue |
| `….dlq` ("dead letter queue") | jobs that failed 12 times (or are unreadable), parked for a human |

**What lives in Redis** (copies and counters only; losing Redis loses nothing important):

| Key | Example | Lives for | Owner |
|---|---|---|---|
| Cached product page | `catalog:product:v1:42` → the product's JSON | ~60 s | catalog |
| Cached "doesn't exist" | `catalog:product:v1:999999` → null | ~10 s | catalog |
| Failed logins per email | `identity:login-failures:<hash of email>` → 3 | 15 min | identity |

Stock, orders, carts and idempotency keys are **never** in Redis: they must survive a crash and be exact.

**Why separate databases?** Later, any module can become its own service (microservice) just by
moving its database. Nothing else has to change, because nobody else reads its tables.

**The cost of that choice:** a single database transaction can't cover two modules. Checkout touches
inventory *and* orders, so it needs an "undo" step if something fails (see §5F).

---

## 5. The journeys: what happens step by step

Every request starts the same way:

```
Request → NGINX → API → [0] Which module?     → [1] Is the user logged in?  → [2] Is the input valid?  → module does the work → MySQL
                          (NestJS matches the      (checks the token's          (unknown fields are
                           URL path, see below)     signature, no DB needed)     rejected → 400)
```

NGINX does **not** pick the module; it only forwards to the app. Inside the app, NestJS matches the path:

| Path | Module |
|---|---|
| `/auth/...` | identity |
| `/products...` | catalog |
| `/inventory/...` | inventory |
| `/cart...` | cart |
| `/checkout`, `/orders...` | orders |
| `/health/...`, `/metrics` | monitoring |

After the microservice split, these same path rules move into NGINX / an API gateway, which then sends
`/cart` to the cart *service*, `/products` to the catalog *service*, and so on.

### A. Sign up

```
1. Customer sends email + password
2. identity: hash the password with Argon2id (slow on purpose, ~30 ms, so stolen hashes are hard to crack)
3. Save user (email + hash) in identity.users          ← the real password is never stored
   - email already exists? The database's "unique" rule says no → 409
4. Create two tokens and send them back (see B)
```

### B. Login, and the two tokens

```
1. Customer sends email + password
2. identity asks Redis: "has this email failed 5 times in the last 15 min?"
   - yes → 429 "too many failed logins" right away, WITHOUT the expensive password check
     (so a guessing flood can't eat our CPU either)
3. identity: find user, check the password against the stored hash
   - unknown email? Still do a fake check, so the answer takes the same time
     (otherwise an attacker could tell which emails have accounts by timing)
   - wrong → count +1 in Redis.  Right → reset the count.
4. Return:
   • ACCESS TOKEN  : valid 15 min. A signed note: "user 123, role customer".
                     Stored NOWHERE on the server. The signature proves we made it.
   • REFRESH TOKEN : valid 30 days. A long random string. Server stores only its hash.
```

Analogy: the **access token** is a festival wristband: security just looks at it, with no phone call needed.
The **refresh token** is the ticket you show at the gate to get a new wristband when the old one expires.

### C. Getting a new access token (refresh)

```
1. Customer sends refresh token
2. identity: find it by its hash. Mark it USED (works only once)
3. Give back a new access token + a NEW refresh token
4. If someone sends an already-used refresh token again → it was probably stolen
   → cancel ALL tokens from that login → everyone must log in again
```

### D. Browse and search products (no login needed)

```
1. GET /products?q=leather boot
2. catalog: ask MySQL using the search index (FULLTEXT) on name + description
3. Return 20 products + a bookmark ("nextAfter") for the next page
```

**Opening one product page (`GET /products/42`) uses the cache ("cache-aside"):**

```
1. catalog asks Redis: "do you have product 42?"
   ├─ yes (HIT)  → return it. MySQL is not touched.
   └─ no  (MISS) → read MySQL → save a copy in Redis for ~60 s → return it
2. 500 people miss the same product at the same moment? Only ONE of them reads MySQL;
   the other 499 wait for that answer ("request coalescing"). Otherwise an expiring
   popular product would hit MySQL 500 times at once ("cache stampede").
3. Redis down or slow (>200 ms)? Skip it and read MySQL. The shop keeps working.
```

**Admin changes a price (`PATCH /products/42`):** write MySQL first, then **delete** the Redis copy.
The next visitor gets a miss and loads the new price.

**Money never comes from the cache.** Cart totals and checkout read prices straight from MySQL. A product
page can be a few seconds stale; the amount we charge can't.

**Pages use a bookmark, not page numbers:** "give me 20 products after id 5,000". The database
jumps straight there. "Skip 5,000 and give me 20" would read 5,000 rows and throw them away.

### E. Add to cart

```
1. PUT /cart/items/42  { quantity: 2 }   (must be logged in)
2. cart: asks catalog "does product 42 exist?"   ← existence, NOT stock
3. Save in cart.cart_items (or update the quantity)
4. Viewing the cart: cart asks catalog for CURRENT prices (prices are never stored in the cart)
```

**Why doesn't adding to cart check stock?** A cart is a wish list, not a reservation: adding an item
doesn't hold it for you. Stock changes every second during a drop, so "5 left" at add-to-cart could be 0
at payment. The only check that can *guarantee* anything is the one at checkout (§F step 4), so that's
where inventory is asked. Trade-off: a customer can learn at checkout that it sold out. Shops soften that
by showing "only 3 left" on the product page, which is information only.

### F. Checkout ⭐ (the most important flow, know this one by heart)

The customer sends `POST /checkout` with an **Idempotency-Key**: a random id the app creates once
per "Buy" press and reuses if it has to retry.

```
 Step                                                   Data touched
 ───────────────────────────────────────────────────    ─────────────────────────────
 1. CLAIM THE KEY                                        orders.idempotency_keys
    Save "user + key = in progress".
    Seen this key before?
      - already finished → send the SAME answer again (no new order)
      - still running    → 409 "processing, retry shortly"

 2. READ THE CART                                        cart.cart_items
    Empty? → 400

 3. GET REAL PRICES                                      catalog.products
    Prices always come from the catalog, never from the customer.

 4. TAKE THE STOCK  (all items, or none)                 inventory.stock + reservations
    For each item, ONE database command:
      "subtract 1, ONLY IF at least 1 is left"
    Database says "done" → reserved.  Says "0 rows changed" → sold out → 409, nothing taken.
    Write down "order X took these items" (reservations).

 5. CREATE THE ORDER  (one transaction = all or nothing) orders.orders + order_items
    Save order (status "pending_payment") + items        + outbox + idempotency_keys
    + an "order.created" note in the outbox (for the email, see §5H)
    + mark the key "completed" with the answer.

 6. If step 5 fails → UNDO step 4: give the stock back   inventory (compensation)

 7. Remove the bought items from the cart                cart.cart_items
 8. Answer 201 with the order
```

**Why step 4 can't oversell:** checking and subtracting happen in **one** command, inside the database.
Nobody can sneak in between "is there 1 left?" and "take it".
Analogy: a vending machine checks and drops the can in one move. Two people can't both get the last can.

**What the naive version does wrong:** it reads "57 left", decides in the app, then writes "56". Fifty
buyers read 57 at the same moment and all write 56. **Measured: 474–499 sold out of 100**, and the stock
still showed a normal-looking 0.

**Why the idempotency key matters:** the network can lose the *answer*. The customer can't tell whether
the order was made, so they press again. With the same key, the second press gets the first answer
instead of a second order. **Measured: 3,000 double-clicks, 0 duplicate orders.**

### G. My orders

```
GET /orders → orders module returns only YOUR orders, newest first, with a bookmark for paging.
Asking for someone else's order id → "not found" (we don't even admit it exists).
```

### H. After "Buy": the confirmation email (in the background)

The customer already has their 201 answer. Everything below happens without them waiting:

```
 1. OUTBOX     checkout saved an "order.created" note in the SAME transaction as the order
               → order exists  ⇔  note exists. Never one without the other.
 2. RELAY      the worker checks the outbox every 0.2 s, takes up to 100 unsent notes
               (FOR UPDATE SKIP LOCKED: several workers can share the work without
               fighting over the same rows), sends them to RabbitMQ, waits until RabbitMQ
               confirms "stored", then marks them sent.
 3. QUEUE      RabbitMQ keeps the job safely on disk until a consumer takes it.
 4. CONSUMER   the worker takes up to 20 jobs at a time ("prefetch"). For each:
                 already in sent_notifications?  → skip (it's a repeat)
                 look up the customer's email (asks the identity module)
                 send the email via SMTP → Mailpit
                 remember the event id in sent_notifications
                 tell RabbitMQ "done" (ack). Only now is the job removed.
 5. FAILURE    mail server down? → job goes to the retry queue, comes back 5 s later.
               Failed 12 times (~1 min)? → parked in the dead-letter queue for a human.
```

**Why not just send the email inside checkout?** Two reasons:
- **The customer waits** for the mail server on every order.
- **Two systems, no shared transaction.** If the order saves and then the mail server fails, the customer sees
  an *error* for an order that *was* created, and the email is never sent. This is the "dual write problem".

**Why can a job arrive twice?** If the worker crashes after RabbitMQ stored a message but before marking
the note "sent", the note is sent again. That's called **at-least-once** delivery. It's fine because the consumer
skips event ids it has already handled (an **idempotent consumer**). Analogy: the postman may ring twice,
but you only sign once.

**Why does the API not talk to RabbitMQ at all?** So that RabbitMQ being down can never fail a checkout.
The API only writes to MySQL; the worker deals with RabbitMQ.

### I. Cleanup jobs (worker, every 60 s)

| Job | Why |
|---|---|
| Release **orphan stock reservations** older than 10 min whose order doesn't exist | If the API crashed between "take stock" and "save order", that stock was stuck forever (the Phase 1 gap) |
| Delete **idempotency keys** older than 24 h | Nobody retries yesterday's click; the table would grow forever |
| Delete **sent outbox notes** older than 7 days | Kept only for debugging |

Every job is safe to run twice at the same time, so several workers need no coordination.

---

## 6. How we watch it (observability)

| What | Where | Used for |
|---|---|---|
| `/health/live` | API | "Is the app alive?" Checks nothing else. |
| `/health/ready` | API | "Can it serve customers?" Pings all 5 databases. |
| `/metrics` | API → Prometheus → Grafana | Requests per second, response times (p50/p95/p99), errors, CPU, event-loop busy %, login hashing time, checkout outcomes (created / sold out / replayed), cache hits/misses, Redis errors |
| `/docs` | API | **Swagger**: a web page listing every endpoint, where you can try them. Log in, click "Authorize", paste the access token. |
| worker `/metrics` | worker → Prometheus | Outbox backlog (notes not yet sent), emails sent / retried / dead-lettered / duplicates skipped, **order → email delay**, RabbitMQ connected |
| RabbitMQ UI | http://localhost:15672 | Queues, how many jobs wait in each, message rates (user `scalecart`, password from `.env`) |
| Mailpit | http://localhost:8025 | Every confirmation email the shop sent |
| `x-instance` header | every response | Shows which copy of the app answered (useful once there are several) |

---

## 7. What's NOT built yet (be honest; interviewers respect it)

| Not yet | Today | Coming in |
|---|---|---|
| Payment | Orders stay `pending_payment` forever, and their stock stays reserved | Phase 4 (payment simulator + saga, payment timeout releases stock) |
| Waiting room for drops | Bursts queue inside the app (p99 up to 27 s in E2) | later (admission control / load shedding) |
| Per-IP login limits | Only per-email | needs the real client IP from NGINX |
| Autoscaling | Copies are added by hand (`API_REPLICAS=4`) | Kubernetes phase |
| Demo website | Swagger page only | Phase 4.5 |
| 2FA, microservices, tracing | – | later |

---

## 8. How to tell it in an interview (2 minutes)

1. **What it is:** "Shop backend for flash sales: login, search, cart, checkout." (§1)
2. **Draw the boxes:** NGINX → API with 5 modules → MySQL with 5 databases, plus Prometheus/Grafana. (§2)
3. **Why 5 databases:** "Modular monolith: one app, but each module owns its data, so I can split it
   into microservices later. Trade-off: no transaction across modules, so checkout has an undo step." (§4)
4. **Walk through checkout:** key → cart → prices → take stock in one command → order in one transaction
   → undo on failure. (§5F)
5. **Prove it with numbers:**
   - Naive stock check: **~5× oversold**. One-command check: **exactly 100 of 100**, every run.
   - Double-clicks: **0 duplicate orders** out of 3,000 requests.
   - Login costs about **60× more CPU** than a product read (~22 logins/s per CPU). Even off the main
     thread it made other requests **8–11× slower** at p99, because they share the CPU limit.
   - Bookmark paging: **1 ms vs 70 ms** for deep pages.
6. **Say what's next:** cache, events, payments, autoscaling. (§7)

6b. **Phase 2 numbers:** the cache cut MySQL reads by **95–97%**. A burst of 2,000 requests stopped failing once
   Node's connection queue was raised from 511 to 4,096 (4,322 dropped attempts → 0). Database reads scale by
   adding *processes*; password hashing scales by adding *cores* to one process.

6c. **Phase 3 numbers:** with the email sent *inside* checkout, a 30 s mail-server freeze gave **60 customers an
   error for orders that existed** (47 never emailed). With the outbox: **0 errors, 0 lost, 0 duplicate emails**
   across a frozen mail server, a killed worker and a restarted RabbitMQ (9,480 orders).

The detailed numbers are in [experiments/E1](experiments/E1-checkout-auth-and-queries.md),
[experiments/E2](experiments/E2-cache-adapters-scaling.md) and [experiments/E3](experiments/E3-outbox-queue-failures.md).
Follow-up questions with answers are in [interview-notes/phase-1](interview-notes/phase-1-shop-core.md),
[interview-notes/phase-2](interview-notes/phase-2-caching-and-scaling.md) and
[interview-notes/phase-3](interview-notes/phase-3-messaging-and-outbox.md).
