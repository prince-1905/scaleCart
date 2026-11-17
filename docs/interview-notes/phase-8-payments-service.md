# Interview notes — Phase 8: Splitting payments out as its own service

Evidence: [E11 experiment report](../experiments/E11-payments-service.md). Plan: [phase-8 plan](../plans/phase-8-payments-service.md).
Code: `apps/payments/` (the new service), `apps/api/src/orders/` (`internal-orders.controller.ts`,
`payment-captured.consumer.ts`, `order-expiry.ts`, `payments-client.ts`), `infra/nginx/nginx.conf`.

---

## 1. The 30-second version

> "We started as a modular monolith with a database per module. I split **payments** out first because it holds the
> money secrets and must keep accepting Razorpay webhooks even when the shop has problems. Only one thing is a **sync
> call**: at 'Pay', payments asks the shop for the order's amount, with a 1 s timeout, one retry and a circuit breaker.
> Everything else is **events through RabbitMQ**, with an outbox on both sides and duplicate checks. I measured it: with
> the shop **down for 60 s**, all 60 webhooks were still accepted and every order caught up ~4–5 s after the restart.
> With payments down, browsing and checkout didn't change. The costs: the hop adds ~1 ms (p99 up to 26 ms), an order
> turns paid ~0.1 s after the webhook instead of during it, and before the tests even started, a broken DNS lookup cut
> payments off from the shop: a failure a monolith can't have."

---

## 2. The customer's view

| I am a customer and… | What happens | Measured |
|---|---|---|
| I click **Pay** | Payments asks the shop "how much, whose, still unpaid?", then asks Razorpay for an order | Pay p50 **90–94 ms**; the shop hop is ~1 ms of that |
| I pay, Razorpay sends the webhook | Payments answers Razorpay at once, the shop marks my order paid a moment later | Webhook **~21–24 ms**, order paid **~95–112 ms** after it |
| …but the **shop is down** right then | My payment is still accepted and waits in the queue as an event | 60 of 60 accepted; orders paid **4–5 s** after the shop came back |
| I click **Pay** while the **shop is frozen** | The first 5 customers wait 2.1 s and get "try again shortly"; after that, everyone gets it in **~3 ms** | Circuit breaker |
| I browse or check out while **payments is down** | No change at all | 0 errors in 300 requests, same latency |
| My order is overdue while payments is down | It is **not** cancelled: the shop can't confirm I didn't pay | 10 of 10 kept, cancelled 26–37 s after payments returned |

---

## 3. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Monolith / microservice** | One program with everything / separate programs that talk over the network | One cook doing everything / a bakery next door |
| **Modular monolith** | One program, but strict module walls (own DB, only public services) | Rooms with locked doors in one house |
| **Sync call** | Ask and wait for the answer (HTTP) | A phone call |
| **Async event** | Leave a message, the other side handles it later (RabbitMQ) | A note in a mailbox |
| **Timeout** | Give up waiting after N ms | Hang up after ringing 10 times |
| **Retry** | Try once more, only for errors that might pass (timeouts, 5xx) | Redial once |
| **Circuit breaker** | After N failures, stop calling for a while; then try one call | Stop redialling a dead line; check again in 10 s |
| **Outbox** | Save the data and the event in one DB transaction; a relay publishes later | Writing the note in the same ledger as the sale |
| **Inbox / idempotent consumer** | Remember which events you handled, so a duplicate does nothing | Ticking off notes you've already read |
| **Eventual consistency** | The two sides agree after a short delay, not instantly | The bakery's ledger is updated a minute after the sale |
| **Service token** | A shared secret header that only our services know (`X-Service-Token`) | A staff badge for the back door |

---

## 4. How the two services talk

```
Customer ── Pay ──► NGINX ──► payments ──(sync GET /internal/orders/:id, 1 s timeout, retry, breaker)──► shop
                                  │
Razorpay ── webhook ─► NGINX ─► payments: save payment + "payment.captured" (outbox, 1 transaction) ─► RabbitMQ
                                                                                                    │
          shop worker ◄─────────────────────────────────────────────────────────────────────────────┘
            mark order paid + "order.payment_result" (outbox, 1 transaction), commit stock
                                  │
          payments ◄── RabbitMQ ──┘  "paid_by_other" or "cancelled" → refund
```
- **Why sync at Pay:** the customer is waiting, and payments must not charge a wrong amount. No answer → 503, nothing
  half-done.
- **Why events for everything else:** they are facts that can be handled a moment later, and they survive an outage.
- **Who owns what:** the shop owns orders, stock and the payment deadline. Payments owns Razorpay keys and payment rows.
  Payments' MySQL user can't even read the shop's tables.
- `/internal/*` is blocked at NGINX (404), and needs the service token anyway.

---

## 5. The stories

### Story A — "Before the first test, the network between my services broke" ⭐
- **Symptom:** every payments → shop call timed out. Each service was healthy on its own; the shop answered through NGINX.
- **Cause:** inside every container, `getaddrinfo` with the `AI_ADDRCONFIG` hint (what Node's `fetch` uses) hung, a
  Docker Desktop / WSL fault. A reboot fixed it.
- **Lesson:** in a monolith this can't happen: a function call doesn't do DNS. In a split system the **link** is a new
  thing to fail, so every sync call needs a timeout and a breaker, and health checks should check dependencies you call.

### Story B — "The shop died for a minute, and no payment was lost" ⭐
- **Proof:** 3 runs × 20 webhooks during a 60 s shop outage: **60 × 200**, 20 events queued each time. All 60 orders were
  paid **4.0–5.4 s** after the start command, almost all of that the worker booting.
- **Why it works:** payments only needs its own DB and RabbitMQ to accept a webhook. The event waits in a durable quorum
  queue.
- **Monolith comparison:** the same outage would have made Razorpay get errors and retry; its retries came 321 s and
  643 s apart in E4b.

### Story C — "The breaker made recovery slower" ⭐
- **Proof:** payments down, 10 overdue orders: **10 of 10 kept** (good: never cancel without checking). But after payments
  came back, they were cancelled only 26–37 s later.
- **Cause (log):** 5 timeouts opened the worker's breaker for 30 s. The next expiry round arrived while it was still open
  and skipped everything; the round after that worked.
- **Trade-off:** shorter open time = faster recovery but more calls into a dead service. Fine for a 15-minute deadline;
  for urgent paths, use a shorter open time or a health probe.

### Story D — "Failing fast is a feature"
- **Proof:** shop frozen (`docker pause`). The first 5 Pay clicks took **2.1 s** each (1 s timeout + 100 ms + 1 s retry).
  Then the breaker opened: **3–4 ms**. 30 clicks at once: all answered within 87–126 ms.
- **Why it matters:** without a breaker, every request holds a connection for 2.1 s. Under real traffic those pile up
  until payments itself runs out of sockets or memory: a **cascading failure**.

### Story E — "Two payments for the same thing deadlocked" (found by tests)
- 20 parallel duplicate payment inserts each took a shared lock on the duplicate key, then all tried to UPDATE → MySQL
  deadlock.
- **Fix:** on a duplicate, read it with `SELECT … FOR SHARE` first and update only rows that had really failed, and
  retry the transaction on deadlock (`retryOnDeadlock`).

---

## 6. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| Payments first | Most sensitive (keys, money), an outside caller (webhooks), a clear border | Pay now depends on the shop being reachable |
| One sync call, the rest events | The customer is waiting only at Pay | Eventual consistency: ~0.1 s where Razorpay says paid and the shop says pending |
| Outbox relay polls every 200 ms | Simple, no change-data-capture tool | ~100 ms average delay, queries on an empty table |
| Shop owns the deadline, asks payments before cancelling | Never cancel an order that was paid | If payments is down, overdue orders wait (stock held a bit longer) |
| Breakers: 5 failures; 10 s (Pay) / 30 s (expiry) | Fail fast, don't hammer a dead service | Slower recovery: up to open time + job interval |
| Separate MySQL user per service | A shop bug can't read payment data, and vice versa | More secrets and grants to manage |
| Same MySQL server (separate databases) | Cheap on one laptop | Not a real failure boundary: MySQL down = both down |

---

## 7. Likely questions

1. **Why microservices at all? Isn't a monolith better at your size?** Honestly, yes. The real reasons are team ownership,
   independent deploys and failure isolation. I split one service to measure those trade-offs, not because the shop
   needed it.
2. **How do the services talk?** Sync HTTP only where an answer is needed now (Pay → order lookup); events through
   RabbitMQ for facts (payment captured, order result). Both sides use an outbox, so an event is never lost or sent
   without its data.
3. **How do you avoid charging twice / marking paid twice?** The payment row has a unique key; a duplicate webhook is a
   no-op. On the shop, "mark paid" is a conditional UPDATE (`WHERE status = 'pending_payment'`), and the reply event has
   a deterministic id, so a redelivered event can't create a second reply.
4. **What if the order was cancelled just before the payment arrived?** The shop replies `cancelled`, and payments
   refunds. Same for a second payment on an already-paid order (`paid_by_other`).
5. **What's a circuit breaker, and what did it cost you?** After 5 failures it stops calling for a while and fails in
   ~3 ms instead of 2.1 s. The cost: it keeps refusing after the other side recovers (26–37 s for expiry in E11d).
6. **No distributed transaction (2PC)?** No: each service commits locally, events carry the rest, and compensation
   (refund) fixes conflicts. That's a **saga**.
7. **How do services authenticate each other?** A shared service token in a header, compared in constant time;
   `/internal` is also blocked at NGINX. Next step: mTLS or signed service JWTs through a gateway/mesh.
8. **How would you debug a request across two services?** Today: logs with the order id in both. Next phase: distributed
   tracing (one trace id across HTTP and RabbitMQ).
9. **What breaks that didn't before?** The network: DNS, timeouts, partial failures (E11-0), plus duplicates and
   ordering of events, and more things to deploy and monitor.

---

## 8. Self-quiz

1. Why is "Pay" a sync call but "payment captured" an event?
2. The shop is down. A customer pays. What does Razorpay get, and when does the order show "paid"?
3. Why does a webhook now answer faster than in the monolith, while the order turns paid later?
4. The first 5 Pay clicks on a frozen shop took 2.1 s. Where do the 2.1 s come from?
5. Why did overdue orders take 26–37 s to cancel after payments came back?
6. What stops a duplicate `payment.captured` event from making two reply events?
7. Name one thing the split did NOT isolate in our setup.

<details><summary>Answers</summary>

1. At Pay the customer is waiting and we need the amount now. A captured payment is a fact that can be applied a moment
   later, and must survive the shop being down.
2. Razorpay gets 200 at once (payments stores it with an outbox event). The order turns paid when the shop worker is back
   and drains the queue: ~4–5 s after restart in E11c.
3. Payments only writes two rows and answers. Marking the order paid now happens after the relay (polls every 200 ms),
   RabbitMQ and the shop worker: ~95–112 ms.
4. 1 s timeout + 100 ms pause + 1 s retry, then the breaker counts one failure.
5. The worker's breaker had opened (30 s) during the outage, and the expiry job runs every 30 s: the first round after
   recovery was still refused.
6. Marking paid is a conditional UPDATE, and the reply has a deterministic id (`stableId(paymentId)`) inserted with
   `ON DUPLICATE KEY UPDATE id = id`.
7. MySQL (one server, two databases), RabbitMQ and the laptop's Docker network. A DNS fault took out the link (E11-0).

</details>
