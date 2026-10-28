# Interview notes — Phase 1: Shop core (auth, catalog, cart, checkout)

Evidence for every number below: [E1 experiment report](../experiments/E1-checkout-auth-and-queries.md).
All numbers were measured on my laptop (i7-12650H, Docker Desktop, API limited to 1 CPU, MySQL 8.4).

---

## 1. The 30-second version

> "I built the shop core as a modular monolith: identity, catalog, inventory, cart and orders, each with its
> own MySQL database. The interesting part is checkout during a flash sale. I reproduced overselling: with
> a read-then-write stock check, 1,000 buyers bought **about 5× the 100 units** in stock, while the stock
> counter showed a perfectly normal zero. One conditional UPDATE fixed it: exactly 100 orders, every run.
> An idempotency key stops double-clicks from creating two orders: zero duplicates out of 3,000 doubled
> requests. I also measured that one login costs as much CPU as about 60 product reads, and that login
> traffic made product reads 8–11× slower at p99 through CPU throttling, even though hashing never blocks
> the event loop."

---

## 2. Key concepts, in plain English

| Term | Meaning | Analogy |
|---|---|---|
| **Race condition** | The result depends on who gets there first | Two people grabbing the last seat |
| **Lost update** | Two requests read the same value, both write, one write is lost | Two cashiers both see "5 left", both write "4" |
| **Atomic conditional update** | Check and change in ONE statement: `UPDATE … WHERE available >= 1` | The shelf itself refuses to hand out the last item twice |
| **Pessimistic lock** (`SELECT … FOR UPDATE`) | Lock the row first, then decide | Take the clipboard, decide, give it back |
| **Idempotency key** | Client sends the same random id on every retry of one action | A ticket number: showing it twice doesn't buy two coffees |
| **Compensation** | Undo step 1 if step 2 fails, because no single transaction covers both | Refund the deposit if the booking fails |
| **Modular monolith** | One deployable app, strict module boundaries, one DB per module | Flatmates with separate fridges: easy to move out later |
| **Argon2id** | Slow, memory-hard password hash | A lock that takes a second to pick, on purpose |
| **JWT access token** | Signed note "user X, role Y, valid 15 min". Checking it needs no DB | A wristband at a festival |
| **Refresh-token rotation** | Every refresh token works once; reuse = theft alarm | A one-time ticket that's replaced each time you use it |
| **Keyset pagination** | `WHERE id > lastSeen LIMIT 20` instead of `OFFSET n` | A bookmark instead of counting pages from the start |
| **FULLTEXT index** | Word → rows index (inverted index) | A book's index at the back |
| **CPU throttling** | Container used its CPU quota, so the kernel pauses it | Data cap reached: everything stops until next period |

---

## 3. The stories (problem → proof → fix → trade-off)

### Story A — "How do you stop overselling in a flash sale?" ⭐ (the main one)
- **Problem:** "check stock, then subtract" is two steps. Between them, other buyers read the same old number.
- **Proof:** 1,000 buyers, 100 units, read-then-write version: **474, 494 and 499 orders** in three runs.
  Stock still showed **0**, so the counter looked fine; only counting orders in the database revealed it.
- **Fix:** one statement does the check and the change:
  ```sql
  UPDATE stock SET available = available - ? WHERE product_id = ? AND available >= ?
  ```
  `affectedRows = 1` → sold. `0` → sold out. InnoDB locks the row and evaluates `WHERE` on the latest
  committed value, so no buyer can slip in between. **Result: exactly 100 orders, 3 of 3 runs.**
- **Extra safety:** the column is `UNSIGNED`, so MySQL refuses to store a negative number (defence in depth).
- **Alternative I measured:** `SELECT … FOR UPDATE` was also correct (100/100). It holds the lock across two
  round trips. On my laptop the latency difference was smaller than run-to-run noise, so I won't claim it's slower.
- **Trade-off / what's next:** every buyer still queues on **one hot row**. At much bigger scale: split stock
  into buckets, pre-load it into Redis (`DECR` is atomic), or put a waiting room in front of the sale.

### Story B — "What if the user double-clicks or the network retries?"
- **Problem:** the client can't tell "request lost" from "response lost", so it retries, which could create a second order.
- **Fix:** client sends `Idempotency-Key: <uuid>`. The server **INSERTs the key first**. The primary key lets
  exactly one request win. Duplicates get the stored response (`Idempotent-Replayed: true`) or a 409
  "still processing, retry". The order and "key completed + stored response" commit in **one transaction**.
- **Proof:** 1,500 buyers each sent their checkout **twice at the same moment** → **0 buyers with 2 orders**.
- **Details that show maturity:**
  - Keys are scoped per user (`PRIMARY KEY (user_id, idem_key)`).
  - Same key + different body → **422** (client bug).
  - If checkout fails (e.g. out of stock), the key is released, so a retry can succeed later.
  - A crashed request leaves an "in progress" key: after 30 s (= the load balancer timeout) a retry may
    take it over, reusing the same order id, so the stock reservation (keyed by order id) isn't taken twice.

### Story C — "Checkout touches two databases. How do you keep them consistent?"
- Inventory and orders are separate modules with separate databases: no single ACID transaction.
- **Order of steps:** claim key → price the cart from the catalog (never trust client prices) → reserve
  stock (inventory DB) → in ONE orders-DB transaction: order + lines + stored response.
- If the orders transaction fails → **compensation**: release the reservation. Reserve and release are both
  safe to repeat because reservations are keyed by `(order_id, product_id)`.
- **Known gap (honest answer):** if the process dies *between* reserve and order, stock stays reserved.
  Fix in Phase 3–4: reservation expiry sweeper + outbox/saga. That's a mini-saga already.

### Story D — "Is your login secure, and what does it cost?"
- **Passwords:** Argon2id at the OWASP minimum (19 MiB memory, 2 passes, 1 lane). Unknown emails do a dummy
  hash, so response time doesn't reveal which emails have accounts. Same error message for both cases.
- **Tokens:** 15-min JWT (HS256, algorithm pinned on verify) + 30-day refresh token. The refresh token is
  256 random bits stored only as a **SHA-256 hash**. A fast hash is fine for random tokens; slow hashing is
  for guessable passwords.
- **Rotation + reuse detection:** each refresh token works once (`UPDATE … WHERE used_at IS NULL`, the same
  atomic trick as stock). Presenting a used one again = probably stolen → revoke the whole family.
- **Cost (measured):** one password check ≈ **29.5 ms CPU**. One API CPU did only **~22 logins/s** vs ~1,360
  product reads/s. That's **~60× more expensive**.

### Story E — "Hashing runs off the event loop, so it's free, right?" ⭐ (surprising result)
- `argon2` runs on libuv's thread pool, and the event loop stayed below 0.7 busy.
- **But:** catalog reads at 500/s had p99 **75–113 ms alone** and **823–949 ms with just 10 logins/s** next
  to them (8–11× worse).
- **Why:** the hashing threads and the event loop share **one CPU quota**. When the quota runs out, the kernel
  pauses the whole container. Throttled time rose from **1–2 s to 11–12 s** per 18 s window.
- **Fixes:** isolate auth into its own pods, rate-limit login, give pods more CPU, and keep users logged in
  with refresh tokens so password logins stay rare. (Compare Phase 0: CPU work *on* the event loop made p99 4× worse.)

### Story F — "Your search is slow" (pagination + search)
- **OFFSET** reads and discards every earlier row: page at row 199,980 = 200,000 rows examined, **70 ms**.
  **Keyset** (`WHERE id > ?`): **20 rows, ~1 ms** at any depth (57× faster at the end).
- **LIKE '%word%' vs FULLTEXT** (nuanced, which interviewers like):
  - Common word: LIKE **1.8 ms** (stops after 20 hits) vs FULLTEXT 48 ms (collects all 16k matches first).
  - No match: LIKE **187 ms** (scans all 200k rows) vs FULLTEXT **0.9 ms**.
  - I chose FULLTEXT: **predictable worst case** beats a great best case. Typos and attackers hit the worst case.
- Ranking, typos, facets → a real search engine (OpenSearch) later.

### Story G — "Why a modular monolith with a database per module?"
- One deployable (simple ops, easy debugging) but boundaries are enforced: modules call each other's
  **services**, never each other's tables. No cross-module joins or foreign keys.
- Splitting a module out later = point its DataSource at another server and replace the service call with HTTP/events.
- **Cost:** no cross-module transactions (see Story C) and joins move into code. Five pools × 5 connections
  = 25 MySQL connections per API instance. With many replicas that hits `max_connections` (151 by default),
  which is why ProxySQL comes later.

---

## 4. Likely follow-up questions

**Q: Why not just use a transaction for the naive version?**
I did: it ran inside a transaction. Under MySQL's default REPEATABLE READ, a plain `SELECT` reads a snapshot.
It doesn't lock, so two transactions read the same value. A transaction alone doesn't prevent lost updates;
you need a locking read (`FOR UPDATE`) or a single conditional UPDATE.

**Q: Optimistic locking (version column)?**
Also works: `UPDATE … SET available = ?, version = version + 1 WHERE id = ? AND version = ?`, retry on 0 rows.
For a hot row with 1,000 buyers it causes lots of retries. The conditional decrement needs no retries.

**Q: How do you avoid deadlocks with multi-item carts?**
Lock rows in a fixed order (sorted by product id), keep transactions short, and retry the whole transaction
on `ER_LOCK_DEADLOCK` (InnoDB rolls the victim back completely, so a retry is safe).

**Q: Why UUIDv7 for order ids instead of UUIDv4 or AUTO_INCREMENT?**
I need the id *before* the INSERT (the stock reservation references it). v7 is time-ordered, so InnoDB appends
to the end of the primary-key index like AUTO_INCREMENT. Random v4 scatters inserts across the index (page splits).
Not guessable like 1, 2, 3. Stored as `CHAR(36) CHARACTER SET ascii` (36 bytes instead of up to 144 in utf8mb4).

**Q: Why money as integer cents?**
Floats can't represent 0.10 exactly, so totals drift. Integers are exact.

**Q: The JWT says role=admin. What if you demote someone?**
They keep admin rights until the access token expires (max 15 min). That's the trade-off for checking tokens
without a DB call. If that's too long: shorter TTL, or a denylist checked in Redis.

**Q: Why tokens in the JSON body and not cookies?**
Simpler for any client and for k6. A browser app should keep the refresh token in an HttpOnly, Secure,
SameSite cookie so JavaScript (and XSS) can't read it.

**Q: Why do migrations run as a separate job, not at app startup?**
Four replicas starting together would race to migrate. One job runs first (Compose: `migrate` service, which
the API waits for; Kubernetes: a Job).

**Q: Two refresh requests from two browser tabs at once: what happens?**
One wins, the other looks like reuse, and the family is revoked, so the user is logged out. That's strict. Some
systems allow a short grace period for the previous token. I chose strict and documented it.

**Q: What surprised you?**
(1) The oversold run's stock counter looked perfect. (2) Off-event-loop hashing still hurt other endpoints via
CPU throttling. (3) LIKE beat FULLTEXT for common words. (4) My first flash-sale run lost 36% of requests to
"connection refused" from the *test rig*, and later 2,000-request bursts hit NGINX → Node connect timeouts.
Always check where an error comes from before blaming the app.

---

## 5. Self-quiz (answer out loud, then check above)

1. Stock shows 0 after the sale. Can you conclude nothing was oversold? Why not?
2. Write the one SQL statement that takes stock safely. How does the app know it worked?
3. A user double-clicks "pay". Walk through what happens to the second request.
4. Checkout reserved stock, then the orders insert failed. What does the code do, and what if the process crashed instead?
5. Why are refresh tokens stored with SHA-256 but passwords with Argon2id?
6. Argon2 doesn't block the event loop, yet product reads got 8–11× slower at p99. Explain.
7. Page 10,000 of a product list is slow. What do you change and why does it help?
8. When is `LIKE '%x%'` faster than FULLTEXT, and why did you still choose FULLTEXT?

<details><summary>Answers</summary>

1. No. Lost updates leave the counter "correct-looking". Count the orders: naive sold 474–499 with stock showing 0.
2. `UPDATE stock SET available = available - ? WHERE product_id = ? AND available >= ?`. `affectedRows = 1` → success, `0` → sold out.
3. Its INSERT of the same (user, key) hits the primary key → it reads the row: completed → stored answer replayed
   (201 + `Idempotent-Replayed`); still in progress → 409 "retry shortly". Never a second order.
4. Catches the error and releases the reservation (compensation), then frees the key. If the process crashed, the
   reservation stays until a sweeper expires it (Phase 3–4), or a retry with the same key takes over after 30 s
   and reuses the order id.
5. Refresh tokens are 256 random bits: impossible to brute-force, so a fast hash is enough. Passwords are short
   and guessable: the hash must be slow and memory-hard to make guessing expensive.
6. The hashing threads share the container's 1-CPU quota with the event loop. Quota used up → kernel pauses
   the whole container (throttling rose from 1–2 s to 11–12 s per 18 s window).
7. Keyset pagination: `WHERE id > :lastSeen ORDER BY id LIMIT 20`. The index jumps straight there: 20 rows read
   instead of all earlier rows (1 ms vs 70 ms at the last page).
8. When the word is very common and you only need the first 20 by id: LIKE stops early. But with no match, LIKE
   scans the whole table (187 ms vs 0.9 ms). FULLTEXT's worst case is bounded by the number of matches, not table size.
</details>
