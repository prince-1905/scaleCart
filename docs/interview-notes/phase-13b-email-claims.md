# Interview notes — Phase 13b: one email per order (claim before sending)

Evidence: [E17](../experiments/E17-email-duplicates.md). Code: `apps/api/src/notifications/order-created.consumer.ts`,
migration `1795500000000-notification-claims.ts`, test `apps/api/test/email-claims.e2e-spec.ts`.

---

## 1. The 30-second version

> "My email worker was 'idempotent': it checked whether an event was already handled, sent the email, then recorded
> it. A load test showed 3 emails instead of 1, so I built a redelivery storm: the same event 10 times at once for 20
> orders. It sent 196 emails. The check and the record were two steps, and copies running at the same time all
> passed the check. The fix is to claim first: one INSERT with the event id as primary key, so exactly one copy wins
> and sends. Losers either see 'sent' and stop, or see 'sending' and retry later in case the winner crashes. After: 20
> emails for 20 orders, and 50 for 50 with 20 copies each."

---

## 2. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **At-least-once delivery** | A message may arrive more than once; never zero times | The postman may ring twice |
| **Idempotent consumer** | Handling the same message twice has the effect of once | You only sign once |
| **Check-then-act race** | Two workers both check "not done yet", then both do it | Two people both see the dishes unwashed and both wash them |
| **Claim (atomic)** | One step that only one worker can win (unique key) | Writing your name on the task board first |
| **Lease / stale claim** | A claim that expires, so a crashed worker can't block forever | A library hold that lapses after a while |

---

## 3. The story ⭐

- **Before:** check → send → record. Storm (20 orders × 10 copies): **196 and 169 emails**.
- **Why:** the worker processes up to 20 messages at once; all copies passed the check before any recorded it.
- **Fix:** INSERT a `sending` claim (event id = primary key) → send → mark `sent`. Send failed → delete the claim.
  Claim older than 60 s → take over (the claimer died).
- **After:** 20 / 20 emails (×2), 50 / 50 with 20 copies each.
- **Trade-off:** still at-least-once. A worker crashing between send and "mark sent" causes one duplicate after 60 s.
  The alternative, recording "sent" before sending, would lose that email instead (at-most-once). For order emails a
  rare duplicate beats a lost confirmation.

---

## 4. Likely questions

1. **Why not exactly-once?** The email leaves our system (SMTP); it can't be in the same transaction as our database.
   You choose which failure you prefer: a rare duplicate or a rare loss.
2. **Why retry instead of dropping a copy that finds a 'sending' claim?** The claiming worker might crash before
   sending; dropping the copy would lose the email.
3. **Why 60 s?** Longer than the slowest possible send (mailer timeouts add up to ~16 s), so a live sender is never
   taken over.
4. **Could you hold a database lock while sending instead?** Yes (a transaction around the send), but a slow mail server
   would then hold database connections and locks: the E3 frozen-mail test would starve the pool.

---

## 5. Self-quiz

1. Why did 10 copies produce up to 10 emails with "check, send, record"?
2. What makes the claim safe when 10 copies run at once?
3. What happens if the worker that claimed an event crashes before sending?
4. Why release the claim when sending fails?

<details><summary>Answers</summary>

1. All copies ran the check before any of them recorded the event: the check and the record were separate steps.
2. The INSERT with the event id as primary key: the database lets exactly one succeed.
3. The other copies keep retrying (every 5 s); after 60 s the claim counts as stale and one of them takes it over and
   sends.
4. So the retry can claim and send it at once, instead of waiting 60 s for the claim to go stale.

</details>
