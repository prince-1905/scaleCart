# Interview notes — Phase 4.5: Drops and the virtual waiting room

Evidence for every number below: [E5 experiment report](../experiments/E5-drops-waiting-room.md).
Measured on my laptop: 1 API replica with 1 CPU, MySQL 8.4, Redis, 1,000 buyers acting at the same second.

---

## 1. The 30-second version

> "A drop is a flash sale: one product goes on sale at an exact time and thousands of people press Buy at once. The
> server enforces the start time, a per-customer limit and one purchase per customer (a MySQL primary key), so a
> countdown in the browser is only a display. In front of checkout there's a **virtual waiting room**: each buyer gets
> a numbered ticket from Redis, numbers are called at a controlled rate, and only a called buyer gets a short-lived
> signed pass that checkout requires. On a healthy run it made checkout **~14× faster at p50 (0.26 s vs 3.7 s)**. On
> bad runs, without it, **259 buyers got a timeout and ~255 of them had actually bought**. With it: zero errors. I then
> tried a 'one out, one in' version and measured an honest trade-off: fewer buyers caught by a stall, but a slower line."

---

## 2. Key concepts, in plain English

| Term | Meaning | Analogy |
|---|---|---|
| **Drop** | A product that goes on sale at an exact time, with limits | A concert's ticket sale at 10:00 |
| **Thundering herd** | Everyone arrives at the same instant | The whole crowd pushing through one door |
| **Virtual waiting room** | Buyers take a number and are let in at a rate the system can serve | A bank's token machine |
| **Admission control** | Deciding how many get in, and when | The bouncer at a club |
| **Open-loop vs closed-loop** | Admit by the clock (50/s) vs admit when someone finishes ("one out, one in") | A timer on the door vs counting people inside |
| **Signed pass** | Proof you were called, checked by signature (no lookup) | A wristband only the venue can print |
| **Fail closed** | When unsure (Redis down), stop rather than guess | Closing the door when the counter breaks |
| **Ghost order** | The order was created, but the customer saw an error | Paying, then the card machine says "failed" |
| **Clock skew / jump** | A server's clock is off, or gets corrected suddenly | A watch that runs fast and gets reset |

---

## 3. The stories (problem → proof → fix → trade-off)

### Story A — "1,000 people press Buy at the same second" ⭐
- **Problem:** with no waiting room, all 1,000 checkouts hit one API at once. Healthy runs: checkout **p50 3.7 s,
  p99 5.1–5.9 s**. Bad runs: p99 **27 s**, and in one run **259 timeouts (504)**.
- **Proof of the ghost-order problem:** in that run the stock went from 1,000 to 4 (**996 orders**) but only 741 buyers
  got "success". ~255 people saw an error for an order that exists.
- **Fix:** the waiting room at 50/s. Healthy runs: checkout **p50 0.25 s, p99 1.1–1.2 s**, at most 26–288 requests
  in flight (vs ~900). Bad runs: slow, but **zero errors**.
- **Trade-off:** total wait got longer (median 12 s vs 6 s), because 50/s was below what the API could do (~110/s).
  **Set the rate from measured capacity.**

### Story B — "How does the waiting room work, exactly?" ⭐
1. `POST /drops/:id/queue` → a Redis **Lua script** gives your existing ticket or `INCR`s a new one, atomically, so
   refreshing or 10 tabs can't jump the line.
2. **Who's called:** tickets up to `seconds since start × rate`. Pure arithmetic: every replica agrees, and no
   background job is needed.
3. Called → a **signed pass** (HMAC: drop, user, ticket, expiry). Checkout verifies it **without Redis or the database**.
4. Checkout also inserts `drop_purchases (drop_id, user_id)`. The **primary key** = one purchase per customer, even if
   two checkouts race. If checkout fails (e.g. sold out), the claim is deleted so they may try again.
- **Why the pass is checked without lookups:** checkout is the hot path; verifying a signature is microseconds and
  still works if Redis is down.

### Story C — "Redis is down during your drop. What happens?"
- Tickets need Redis, so the line **fails closed**: 503 "waiting room unavailable", and the drop pauses.
- Stock and orders are in MySQL, so Redis being down can **delay** a drop but **never oversell** it.
- Passes already issued still work (signature only). That's covered by a test that points the app at a Redis that
  isn't there.
- **Seen live:** 5–53 queue calls per run got 503 under load. Redis was fine, but the busy API missed our 200 ms Redis
  timeout. The clients retried after 1 s. A longer timeout for queue calls would help.

### Story D — "I fixed the weakness, then measured that the fix had its own" ⭐ (honesty story)
- **Weakness:** the time-based room keeps admitting 50/s **during** a database stall, so in-flight grew to 438 vs 26.
- **Fix:** "one out, one in" (closed loop). At most 50 called buyers. A place frees when one buys, sells out, or their
  60 s lease ends.
- **Fair test:** the same deliberate 5 s jam (a lab endpoint holds the stock row lock) in every mode.
- **Result:**
  - checkout **p95 1.1–1.8 s vs 3.3–4.6 s**, so fewer buyers were caught by the jam ✅
  - but the line moved at **~23/s instead of 50/s** (median time to order 30–34 s vs 12 s) ❌
- **Why:** a freed place stays empty until the next buyer *polls* and learns it's their turn.
- **Real fix:** push "your turn" (SSE/WebSocket), or call a few more than 50. Both are next steps.

### Story E — "Your server's clock lied" (distributed-systems story)
- 39 buyers **holding a valid pass** were told "drop not started". The API container's clock ran **up to 0.8 s ahead**
  and was **stepped back every ~27 s** (`Time jumped backwards` in dmesg).
- **Fix:** a valid pass *proves* the drop started, since passes are only issued after the start. So checkout trusts
  the pass and doesn't re-read the clock. Durations use `performance.now()` (a monotonic clock), never `Date.now()`.
- **Lesson:** don't make two decisions from two readings of a clock you can't trust. For absolute times across
  machines, use one authority, or carry the decision in a signed token.

---

## 4. Likely follow-up questions

**Q: Why not just add more servers?**
It helps, and the API is stateless, so replicas share the same Redis line and the same MySQL. But the hot spot is
**one stock row**, and every buyer of that product waits for its lock. More replicas mean more contention on that row.
The waiting room limits how many contend at once; splitting stock into buckets would raise the ceiling (not built).

**Q: Is the line fair?**
FIFO by arrival at the queue call. People who join before the start get the earliest numbers; some real systems
randomize those (a lottery) so refreshing early doesn't win. One ticket per customer (Redis `SET` per user) and
one purchase per customer (MySQL primary key). Bots with many accounts are a separate problem (captcha, verified
accounts).

**Q: Why is the pass short-lived?**
So a called buyer can't hoard their turn or pass it on. 5 minutes in time mode; in "one out, one in" mode the pass
lasts exactly as long as the place (60 s), so no pass outlives its place.

**Q: What happens if the customer is called but never buys?**
In time mode, nothing is blocked: the line keeps moving. In window mode their place is held until the 60 s lease
ends, which is part of why the window mode moved slower.

**Q: What would you change for production?**
- push notifications instead of polling
- an admit rate set from load tests (and adjusted live)
- a longer Redis timeout for queue calls
- per-IP/device limits against bots
- metrics and alerts on queue length, admitted rate and 503s
- NTP-disciplined clocks (and passes as the source of truth)

---

## 5. Self-quiz (answer out loud, then check above)

1. Why can't the countdown in the browser be the rule?
2. Walk through what happens from "Join the line" to "Buy now".
3. What stops one customer buying twice, even with two checkouts at the same instant?
4. Redis goes down at 10:00. What do buyers see, and why can't it oversell?
5. Time-based vs "one out, one in": what did each do better in your test, and why?
6. What did the clock bug look like, and how did you fix it without fixing the clock?

<details><summary>Answers</summary>

1. The browser's clock and code belong to the customer, so anyone can change them. The server checks the start
   time and requires a pass at checkout.
2. A Redis Lua script gives you a ticket (the same one if you ask again). The ticket is called when
   `seconds × rate ≥ ticket` → you get a signed pass → checkout verifies the signature, inserts
   `drop_purchases (drop, user)`, reserves stock, and creates the order.
3. The MySQL primary key on `drop_purchases (drop_id, user_id)`: only one INSERT wins.
4. A 503 "waiting room unavailable" (fail closed). Already-issued passes still work. Stock is decided by MySQL's
   conditional UPDATE, so it never oversells.
5. Time-based: the line moved faster (median 12 s), but it kept admitting during a stall. Window: fewer buyers caught by
   the stall (p95 1.1–1.8 s vs 3.3–4.6 s), but a slower line (~23/s), because freed places wait for the next poll.
6. Buyers with valid passes got "not started": the container clock ran up to 0.8 s fast and was stepped back every
   ~27 s. Fix: a valid pass proves the drop started, so checkout doesn't re-check the clock; durations use a
   monotonic clock.
</details>
