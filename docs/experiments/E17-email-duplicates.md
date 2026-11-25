# E17 — Duplicate confirmation emails: claim before sending

**Date:** 2026-11-25 · **Phase:** 13b (small fix) · **Status:** done

## The bug

Found during Phase 13's test runs: under heavy load, phase3's "one email even when the same event is delivered three
times" got **3 emails**. The email worker (since Phase 3) did:

```
already in sent_notifications?  → no  → send the email → INSERT the event id
```

Copies of the same event handled at the same moment (the worker takes 20 messages at once) all pass the check before
any of them has inserted: each sends.

## The fix

Claim first, then send:

1. `INSERT IGNORE … status 'sending'` with the event id as primary key: exactly one copy gets `affectedRows = 1`.
2. The others: row `sent` → duplicate, acknowledged; row `sending` → back to the retry queue (5 s), not dropped: the
   claiming worker might crash. These retries don't count toward the 12 failure attempts (own cap: 30).
3. A `sending` claim older than **60 s** (longer than the slowest send: 3 s connect + 3 s greeting + 10 s socket)
   belongs to a dead worker: one copy takes it over with a conditional `UPDATE … WHERE claimed_at < NOW() - 60 s`.
4. Send failed → the claim is deleted, so the retry can send. Sent → `status = 'sent'`.

Migration `1795500000000-notification-claims` adds `status` and `claimed_at` (existing rows = `sent`).

## E17a — Redelivery storm against the real worker

`apps/api/scripts/e17-email-storm.ts`: for each of N made-up orders, the same `order.created` event is published C
times back to back to the dev stack's RabbitMQ; then the emails per order are counted in Mailpit (waiting until the
count stops changing).

| Run | Orders × copies | Emails | Orders with more than one email | With none |
|---|---|---|---|---|
| Before, 1 | 20 × 10 | **196** | 20 | 0 |
| Before, 2 | 20 × 10 | **169** | 18 | 0 |
| After, 1 | 20 × 10 | **20** | 0 | 0 |
| After, 2 | 20 × 10 | **20** | 0 | 0 |
| After, 3 | 50 × 20 | **50** | 0 | 0 |

- Before: up to 10 emails per order (one per copy).
- After: exactly one per order. The worker's counters over the three "after" runs add up: 1,400 copies = **90 sent** +
  **1,310 duplicates**; 730 of those first found a fresh claim (`claimed_elsewhere`), came back 5 s later and then
  saw `sent`.
- Cost: copies that lose to a fresh claim are delivered again 5 s later (extra queue traffic, not extra email).

## Tests

`test/email-claims.e2e-spec.ts` (own queue prefix `test-email.`, so other test files' workers never take its
messages):
- 10 copies of one event at the same moment → exactly 1 email.
- The first send fails → the claim is released → the retry sends it (2 attempts for this event, 1 email).
- A fresh claim held elsewhere → no email after 2.5 s (retried, not dropped); once the claim is stale → taken over →
  1 email.

Mutation-checked: no claim (the old check → send → record) fails all 3; a failed send keeping its claim fails the
second; dropping (acking) a copy that finds a fresh claim fails the third.

Passing on 2026-11-25: shop 77 unit, **155 end-to-end** (full run, 4 files at a time).
A first full run failed the "retry" test: the suite's own queues keep messages between runs, and leftovers from the
mutation runs were sent during that test (16 calls on the mailer spy). The test now counts only its own event's sends.

## What's left (on purpose)

"At least once" stays: a worker that dies after sending but before marking `sent` loses its claim after 60 s, and the
email goes out again. SMTP can't take part in a database transaction, so a duplicate can be made rare, not impossible.
