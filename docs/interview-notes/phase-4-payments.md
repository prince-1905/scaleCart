# Interview notes — Phase 4: Payments with Razorpay (webhooks, idempotency, timeouts, refunds)

Evidence for every number below: [E4 experiment report](../experiments/E4-payments.md).
Measured on my laptop with **Razorpay test mode** (real Razorpay API and checkout, fake money), webhooks through a
cloudflared tunnel, 1 API replica, MySQL 8.4.

---

## 1. The 30-second version

> "Checkout reserves stock and creates the order as 'waiting for payment'. Paying opens Razorpay's checkout. The order
> becomes paid when **Razorpay's signed webhook** says so, server to server, not when the browser says so. Razorpay
> delivers each event at least once and maybe out of order, so every path (webhook, browser, a background check) ends
> in one function that is safe to repeat, and the order changes through **one conditional UPDATE**, so it can only be
> paid once. I fired **100 webhooks for one payment at once: exactly 1 'paid', 99 'duplicate'**, in 6 out of 6 runs.
> Unpaid orders are cancelled after 15 minutes and their stock goes back, but only after asking Razorpay 'was it paid?',
> because webhooks get lost. Money that arrives too late, or twice, is refunded automatically."

---

## 2. Key concepts, in plain English

| Term | Meaning | Analogy |
|---|---|---|
| **Payment gateway** (Razorpay) | Takes the customer's money for us and tells us the result | The card machine and the bank behind it |
| **Webhook** | The gateway calls *our* server when something happens (server to server) | The bank sending the shop an SMS: "₹2,499 received" |
| **Callback / redirect** | The customer's browser comes back to us after paying | The customer saying "I paid at the counter" |
| **HMAC signature** | A code computed from the message + a shared secret; proves who sent it and that nothing changed | A wax seal only the bank has |
| **Raw body** | The exact bytes received. The signature is over these, so parse *after* checking | Checking the seal before opening the letter |
| **At-least-once delivery** | An event can arrive twice (or 20 times), never zero | The postman may ring twice |
| **Idempotent** | Doing it twice has the same effect as once | Pressing a lift button twice |
| **Conditional UPDATE** | `UPDATE … WHERE status = 'pending_payment'`: only changes the row if it's still in the expected state | "Mark as sold, *only if* not sold yet" |
| **State machine** | The allowed moves: pending_payment → paid, or pending_payment → cancelled. Nothing else | A ticket: unused → used, never back |
| **Reconciliation** | Asking the gateway what really happened, instead of waiting for a message | Checking your bank statement |
| **Compensation (saga)** | Undoing an earlier step when a later one fails: here, a refund | Returning the money when the item can't be delivered |
| **Capture** | The money is actually taken (vs only authorized/held) | The hold on a hotel card becoming a charge |

---

## 3. The stories (problem → proof → fix → trade-off)

### Story A — "Why do you need the webhook if the browser already says 'paid'?" ⭐
- **Problem:** the browser is an unreliable messenger. The customer can close the tab, lose signal, or fake a request.
  If only the browser tells us, a paid customer can end up with a cancelled order, and a faker gets free shoes.
- **Design:** three ways the result can reach us, all ending in one safe-to-repeat function:
  1. the **webhook** (source of truth, signed by Razorpay)
  2. the **browser** (just faster: we check the signature *and* ask Razorpay before believing it)
  3. the **timeout job** (asks Razorpay before cancelling, which catches lost webhooks)
- **Proof (live):** `payment.captured` reached us at 19:46:50.490 and was processed in **58 ms**. `order.paid` for
  the same payment came **10 ms later** → duplicate. Then the browser's callback → duplicate.
  Three messages, one payment.
- **Trade-off:** more moving parts than "trust the redirect", but no lost or double-counted payments.

### Story B — "How do you handle duplicate webhooks?" ⭐
- **Two layers:**
  1. A `webhook_events` table keyed by Razorpay's event id: a finished event is answered at once. It's **only a shortcut.**
  2. The guarantee: the order changes through `UPDATE orders SET status='paid' … WHERE id=? AND status='pending_payment'`.
     InnoDB lets exactly one request change the row; the others see 0 rows and become "duplicate".
- **Proof:** 50 copies of one event + 50 different events for the same payment, all at once through NGINX:
  **1 paid, 99 duplicate, 6 out of 6 runs**. In some runs, copies arrived **while the first was still running** and got
  past the event table (2 in one run, 4 in another). The conditional UPDATE stopped every one.
- **Mutation test:** I removed `AND status = 'pending_payment'`, and 12 tests failed. So the tests really guard it.
- **Why not just a lock or Redis?** The database row *is* the lock, and it's already where the truth lives.

### Story C — "The first live run: nothing worked" ⭐ (debugging story)
1. **"International card not allowed":** I used 4242…, which is Stripe's test card. Razorpay counts it as foreign, and a
   new account accepts Indian cards only. Found by **fetching the failed payments from Razorpay's API**, not by guessing.
2. **Payments stuck in `created`:** the bank page opens in a pop-up, which the browser never showed. Fix: Checkout's
   **redirect mode** plus a callback route that verifies the signature and sends the browser back.
3. **Webhooks "never came":** a counter showed **9 rejected deliveries** with a bad signature. The secret in the
   dashboard didn't match `.env`. Two lessons:
   - a rejection must **log**, not only count (fixed)
   - after a secret change, Razorpay still signs **retries of old events with the old secret**
4. **Bonus measurement:** Razorpay's retry spacing for one rejected event was **321 s, then 643 s**, i.e. exponential
   backoff, seen live.

### Story D — "What if the customer pays after the order expired?" (race + compensation) ⭐
- The timeout job and a late payment can hit the same order at the same moment. Both use a conditional UPDATE
  (`WHERE status = 'pending_payment'`), so **exactly one wins**:
  - payment wins → paid, stock committed
  - timeout wins → cancelled, stock released, and the late payment is marked `refund_pending` (reason
    `order_cancelled`)
- The **worker** sends the refund, not the webhook handler. The webhook must answer within 5 s, and a refund call
  can be slow or fail. The refund carries a **receipt** (`rf_<payment id>`) that Razorpay won't accept twice, so a crash
  or two workers can't refund twice.
- Same path for **paid twice** (second tab) and **wrong amount**.
- To make it rare: the checkout page closes itself before the order expires (`timeout` option), and the API refuses to
  open a payment with less than 60 s left.
- **Honest:** proven with the fake provider in tests (late payment refunded once over two refund rounds; a failed refund is
  retried). Not yet run against real Razorpay.

### Story E — "Your cleanup job met 40,000 rows" (backlog story)
- On first deploy, 40,307 unpaid orders from old load tests were waiting. The job did **one batch of 100 per 30 s
  round**: ~200/min, so **~3.4 hours**.
- **Fix:** keep taking batches until none are left, with a 20 s budget per round, and stop if a batch changed nothing
  (otherwise, with Razorpay down, it would spin on the same oldest orders).
- **Result:** **3,571 in the first minute; all 39,807 in 18 rounds (~8 min)**, ~7 ms per order.
- **Lesson:** design background jobs for the backlog they'll meet on day one, not for the steady state.

### Story F — "Why don't you cancel when Razorpay is down?"
- Cancelling releases the stock and someone else buys it. If the customer had actually paid, we'd owe them shoes we
  no longer have. **Never cancel what you couldn't check:** the order waits for the next round. Covered by a test.

---

## 4. Likely follow-up questions

**Q: Why verify the signature on the raw body?**
The signature is over the exact bytes. Parsing and re-serializing JSON can change spacing or key order, and the
check would fail (or you'd be checking something else). Nest's `rawBody: true` keeps the bytes. The compare is
constant-time (`timingSafeEqual`).

**Q: Why answer 500 when processing fails?**
Razorpay treats any non-2xx as "not delivered" and retries for 24 hours. A retry finishes the job, because every step
is safe to repeat. Forged requests get 400.

**Q: Why not mark the order paid when the browser comes back?**
We do, but only after checking the signature `HMAC(order_id|payment_id)` with *our* stored order id **and** fetching
the payment from Razorpay. If Razorpay's API is slow, the browser gets "processing" and the webhook settles it.

**Q: Where's the money stored? Card data?**
Nowhere in our system. Razorpay's checkout collects card details. We only store ids, amounts and statuses, so our
PCI scope stays minimal.

**Q: Why a separate payments database?**
Same rule as every module (modular monolith): payments owns its tables and talks to orders and inventory through
their services. Splitting it into a service later means moving a database, not untangling joins. Cross-database
steps are kept safe by idempotency, retries and reconciliation, not by one big transaction.

**Q: What would change in production?**
- a stable public URL and Razorpay's webhook IP allow-list instead of a tunnel
- secret rotation that accepts old and new secrets for 24 h
- alerts on `payment_webhooks_total{result="bad_signature"}` and on refunds failing
- more replicas (the webhook handler is stateless)
- a proper "payment status" page instead of polling

---

## 5. Self-quiz (answer out loud, then check above)

1. Name the three ways a payment result reaches ScaleCart. Which one do you trust, and why?
2. 50 copies of the same webhook arrive at once. What exactly stops a double "paid"?
3. A customer pays at minute 16, after the order was cancelled at minute 15. Walk through what happens.
4. Why doesn't the webhook handler call Razorpay's refund API itself?
5. Your first live webhooks all failed. How did you find out, and what two lessons did you take?

<details><summary>Answers</summary>

1. Webhook (trusted: signed by Razorpay, server to server), browser (fast, but checked: signature plus a fetch from
   Razorpay), timeout job (asks Razorpay before cancelling).
2. The conditional `UPDATE … WHERE status='pending_payment'`: one row change wins, the rest see 0 rows → duplicate.
   The event-id table is only a shortcut (copies that arrive together can pass it).
3. The timeout job won the conditional UPDATE: cancelled, stock released. The webhook arrives → markPaid finds
   "cancelled" → payment marked `refund_pending` (reason order_cancelled) → the worker refunds with receipt
   `rf_<payment id>` → `refunded`. A repeat can't refund twice.
4. The webhook must answer within 5 s, and a refund call can be slow or fail. The worker retries it safely
   (receipt idempotency), like an outbox.
5. A counter (`bad_signature` = 9) showed it, with no log line. Lessons: log rejections loudly; the dashboard secret
   must match `.env`, and old events keep the old secret on retries.
</details>
