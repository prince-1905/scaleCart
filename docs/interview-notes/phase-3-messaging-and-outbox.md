# Interview notes — Phase 3: Background work, message queues, and the outbox

Evidence for every number below: [E3 experiment report](../experiments/E3-outbox-queue-failures.md).
Measured on my laptop (Docker Desktop, API and worker 1 CPU each, RabbitMQ 4.3, MySQL 8.4).

---

## 1. The 30-second version

> "After an order, ScaleCart sends a confirmation email, without making the customer wait and without ever losing or
> doubling one. Checkout saves an 'order.created' event in the **same database transaction** as the order (the
> transactional outbox). A separate worker publishes it to RabbitMQ and another part of the worker sends the email.
> I broke it on purpose: froze the mail server, killed the worker, restarted RabbitMQ. **Zero checkout errors, zero lost
> emails, zero duplicates** across 9,480 orders. With the 'obvious' design, email sent inside the request, a 30-second
> mail outage gave **60 customers an error for orders that were actually created**, and 47 never got their email."

---

## 2. Key concepts, in plain English

| Term | Meaning | Analogy |
|---|---|---|
| **Message queue** (RabbitMQ) | A safe waiting line for jobs between programs | The order rail in a restaurant kitchen |
| **Producer / consumer** | Who puts jobs in / who takes them out | The waiter / the cook |
| **Worker** | A background program that does slow jobs | The kitchen: customers never go in |
| **Dual-write problem** | Writing to two systems (DB + email/queue) with no shared transaction: one can succeed while the other fails | Paying at the till, but the kitchen never got the slip |
| **Transactional outbox** | Save the "send this" note in the *same* DB transaction as the order; send it later | Writing the kitchen slip on the same receipt as the payment |
| **At-least-once delivery** | A message may arrive more than once, but never zero times | The postman may ring twice |
| **Idempotent consumer** | Handling the same message twice has the same effect as once | You only sign for the parcel once |
| **Ack** | Consumer tells RabbitMQ "done, delete it". No ack = it comes back | Ticking off a job |
| **Prefetch** | Max jobs handed to one consumer at once (back-pressure) | A cook takes 20 tickets, not the whole rail |
| **Retry queue** | Failed jobs wait 5 s, then return | "Try again in a moment" tray |
| **Dead-letter queue (DLQ)** | Jobs that keep failing are parked for a human | The "problem orders" box |
| **Quorum queue** | RabbitMQ's crash-safe, replicated queue type | A ledger copied to several notebooks |
| **Publisher confirms** | RabbitMQ says "stored safely" for each message | A delivery receipt |

---

## 3. The stories (problem → proof → fix → trade-off)

### Story A — "Why not just send the email in the checkout request?" ⭐
- **Problem:** two systems, no shared transaction. The order saves, then the mail server fails → the customer
  gets an error for an order that **exists**. Retrying with the same idempotency key replays the order, and the email is never sent.
- **Proof:** mail server frozen for 30 s at 30 checkouts/s: **60 failed checkouts, all 60 orders existed, 47 never emailed**.
  13 more requests hung for 30 s until NGINX returned 504.
- **Fix:** transactional outbox. With the same freeze: **0 failed checkouts, 2,602 orders, 2,602 emails**. The emails waited
  in the retry queue and arrived up to ~38 s late.
- **Honest nuance:** with a healthy *local* mail server, sending inline cost only ~1–3 ms. The outbox isn't about speed;
  it's about **one slow or broken dependency not breaking checkout**.

### Story B — "How does the outbox work, exactly?" ⭐
1. Checkout's transaction inserts the order, its lines **and** an `outbox` row with the `order.created` event.
   Either all exist or none.
2. The **relay** (in the worker) polls every 200 ms:
   `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`.
3. Publishes them to RabbitMQ, **waits for publisher confirms**, then `UPDATE … SET published_at = NOW()`, commit.
4. **SKIP LOCKED** lets several workers share the outbox: each takes rows nobody else has locked, without waiting.
- **Alternative:** Change Data Capture (Debezium reading MySQL's binlog). No polling, but one more system to run.

### Story C — "What if a message is delivered twice?" (exactly-once is a trap)
- The relay can crash **after** RabbitMQ stored the message but **before** marking the row published → it's sent again.
  RabbitMQ also redelivers anything not acked when a consumer dies. So delivery is **at-least-once**.
- **Fix:** an **idempotent consumer**. Before sending, it checks `sent_notifications` for the event id; after sending, it records it.
- **Proof:** an e2e test delivers the same event 3 times → **1 email**. Killing the worker mid-run: **0 duplicates**.
- **Honest gap:** crash *between* "email sent" and "id recorded" can still double-send. With an outside system
  (SMTP) you can make duplicates rare, never impossible. If you say "exactly-once" in an interview, explain this.

### Story D — "What if the mail server is down?" (retries done right)
- Failed send → the message is copied to a **retry queue** with a 5 s expiry. RabbitMQ moves it back to the main queue
  when it expires: a delayed retry with no timer in our code.
- After **12 attempts (~1 min)** → **dead-letter queue** for a human. Unreadable messages go there immediately.
- The original is only **acked after** the copy is confirmed, so nothing is dropped in between.
- **Why not just requeue immediately?** It would retry thousands of times per second and burn the attempt limit in
  milliseconds. That's a "retry storm".

### Story E — "What happens if RabbitMQ or the worker dies?"
- **The API never talks to RabbitMQ.** It only writes to MySQL, so a broker outage can't fail a checkout.
- **Proof:** worker killed for ~36 s at 40 orders/s → 0 checkout failures, outbox backlog grew to 322, then drained:
  **3,278 orders, 3,278 emails, 0 lost, 0 duplicates**. RabbitMQ restart → 3,600 / 3,600.
- **Trade-off:** emails are **eventual**. Normally ~0.2 s after the order; during an outage, up to ~1 min.

### Story F — "I found a stall that wasn't my new code" (debugging maturity) ⭐
- Some runs showed checkout p99 of 6–13 s, while the API's CPU was idle-ish, so requests were **waiting**.
- **Control run with nothing broken:** same stall → not the outbox.
- **MySQL lock waits:** 10 checkouts waiting on the **same stock row**, blocked by a transaction stuck in **COMMIT**.
- **Why:** each commit waits for the disk (redo log + binlog fsync). On this laptop's virtual disk the slowest fsyncs
  took **3.9 s** and **2.3 s**. Checkout holds the hot row lock until COMMIT finishes → everyone queues behind one slow disk write.
- **Lesson:** a hot-row design is only as fast as its commit. Fixes: fast reliable disks, fewer fsyncs per commit
  (with a durability trade-off), or splitting a hot product's stock into buckets / reserving in Redis.

### Story G — "Cleanup: closing the gaps from Phase 1"
- **Orphan reservations:** if the API crashed between "reserve stock" and "save order", stock stayed reserved forever.
  Every 60 s the worker finds reservations older than 10 min whose order doesn't exist and releases them.
- **Idempotency keys** older than 24 h and **sent outbox rows** older than 7 days are deleted in batches of 1,000,
  so the DELETE never holds locks for long.
- All jobs are safe to run concurrently, so extra worker replicas need no leader election.

---

## 4. Likely follow-up questions

**Q: Why RabbitMQ and not Kafka?**
RabbitMQ is a job queue: per-message acks, retries, dead-lettering, routing. That fits "send this email". Kafka is an
append-only log for high-throughput event streams that many consumers can replay. I'd pick Kafka for analytics or
event sourcing at large scale.

**Q: Why a quorum queue?**
It's RabbitMQ's durable, replicated queue type (Raft consensus). On one node it isn't replicated yet, but the same
declaration works on a 3-node cluster, so messages survive a node failure.

**Q: Does message order matter here?**
No: each email is independent. If order mattered (e.g. "paid" after "created"), I'd route all events of one order
to the same queue and consumer, or include a version and ignore older events.

**Q: Why poll the outbox every 200 ms instead of "push"?**
Simple and robust: no extra infrastructure, and the worst added delay is 200 ms. The cost is constant small queries.
CDC (binlog) removes polling at the cost of running Debezium/Kafka Connect.

**Q: Why is the worker a separate process from the API?**
Different scaling needs (traffic vs. backlog), and isolation: a stuck email can't slow the API's event loop. Same
codebase and Docker image, different entry point.

**Q: What does `prefetch 20` do?**
RabbitMQ gives each consumer at most 20 unacknowledged messages. When the mail server is slow, the backlog stays safely
in RabbitMQ instead of piling up in the worker's memory.

**Q: How do you watch this in production?**
Outbox backlog (`outbox_pending_events`), queue depths (RabbitMQ metrics), order → email delay (histogram), retried and
dead-lettered counts. Alert on DLQ > 0 and on the backlog growing for minutes.

---

## 5. Self-quiz (answer out loud, then check above)

1. Checkout saved the order, then the email failed. What did the customer see in the sync design, and why is that bad?
2. What exactly is written in the same transaction as the order, and why does that matter?
3. Why can the same email job arrive twice, and what stops the customer from getting two emails?
4. The mail server is down for 1 minute. Walk through what happens to one email job.
5. RabbitMQ is restarted during a sale. What do customers notice?
6. Checkouts stalled for seconds, but the API's CPU was mostly idle. What did you find?

<details><summary>Answers</summary>

1. HTTP 500 (or 504), even though the order existed and would never be emailed: 60 errors and 47 missing emails in E3b.
   Two systems, no shared transaction (dual write).
2. The order, its lines, the `order.created` outbox row, and the idempotency key's stored answer. Order and event exist
   together or not at all, so no lost emails and no emails for orders that don't exist.
3. At-least-once delivery: relay crash after publish but before marking sent, or a consumer dying before ack. The consumer
   records each event id in `sent_notifications` and skips repeats.
4. Send fails → copied to the retry queue (5 s TTL), original acked → back in the main queue after 5 s → try again …
   up to 12 attempts (~1 min) → dead-letter queue. When the server returns, the next attempt succeeds.
5. Nothing: the API only writes to MySQL. Events wait in the outbox and are published when RabbitMQ is back
   (0 failures, 3,600/3,600 emails).
6. Checkouts were waiting on one hot stock row, blocked by a transaction stuck in COMMIT. Slow disk fsyncs (up to 3.9 s)
   held the row lock. A control run with nothing broken showed it too, so it wasn't the new code.
</details>
