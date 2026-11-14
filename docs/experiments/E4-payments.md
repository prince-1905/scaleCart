# E4 — Payments with Razorpay: webhooks, duplicates, timeouts

**Date:** 2026-11-03 (IST; log times below are UTC, 2026-11-02 19:xx) · **Phase:** 4 · **Status:** done

## Setup

| Item | Value |
|---|---|
| Host | Laptop, Intel i7-12650H (6P + 4E cores, 16 threads), 15.7 GB RAM, Windows 11, Docker 28.3.2 (Docker Desktop) |
| Provider | **Razorpay test mode** (real Razorpay API and Checkout, fake money). New account: domestic cards only, no UPI offered |
| Path for webhooks | Razorpay → **cloudflared** 2026.10.7 quick tunnel (`https://…trycloudflare.com`) → NGINX 1.30.6 → API |
| API / worker | 1 API replica (Fastify) · 1 worker (payment jobs every 30 s) |
| Database | MySQL 8.4.13, new database `scalecart_payments` (payment_attempts, payments, webhook_events) |
| Payment timeout | 15 min (`PAYMENT_TIMEOUT_SECONDS=900`) |
| Raw notes | session notes, not committed. Storm script: `apps/api/scripts/e4-webhook-storm.ts` |

How a payment's result reaches us (any order, any number of times), all ending in one function, `applyPayment()`:

1. **Webhook** from Razorpay (server to server, signed with HMAC-SHA256 over the raw body): the source of truth.
2. **Browser** after Checkout (`/payments/razorpay/confirm`, or the redirect `/payments/razorpay/callback`):
   signature check + we ask Razorpay for the payment before believing it. Only makes the page faster.
3. **Timeout job**: before cancelling an unpaid order, asks Razorpay "was it paid?" (catches lost webhooks).

The order changes only through one conditional UPDATE (`… WHERE status = 'pending_payment'`), so exactly one of
those messages can ever mark it paid.

---

## E4a — The first live run: what broke before the first rupee moved

One Razorpay order (`order_TvPoFWFkIgY24S`, ₹2,499) collected **9 payment attempts, none successful**:

| Attempts | Method | Razorpay's record | Cause |
|---|---|---|---|
| 2 | card …4242 | `failed`, `international_transaction_not_allowed` | 4242 4242 4242 4242 is a *foreign* test card; a new Razorpay account takes domestic cards only |
| 4 | card …1007 (domestic Visa debit) | stayed `created` | the bank/OTP page opens in a **pop-up window**; the browser (Edge) never showed it |
| 2 | netbanking (PUNB_R, YESB) | stayed `created` | same pop-up |
| 1 | wallet | `failed`, `payment_cancelled` | cancelled on the wallet page |

Also seen: Razorpay's "save this card" step sends a **real SMS OTP** to the customer's phone (not the test bank's
OTP). "Skip OTP" continues.

**Fix:** Checkout in **redirect mode** (`redirect: true` + `callback_url`). The bank page replaces our page instead of
opening a pop-up; afterwards Razorpay POSTs the result (payment id + signature, or `error[...]` fields) to a new route
`POST /payments/razorpay/callback`, which verifies it and sends the browser back to `/demo/` with a 303.

**First successful payment** (`pay_TvQF9prQTUnj57`): attempt created 19:28:05.635, payment row written 19:28:51.550,
order paid **through the browser callback**. No webhook was accepted (see E4b).

Side finding: the demo page was unstyled because NGINX served `demo.css` as `text/plain` (no `mime.types`).

## E4b — The webhook in real life

| Observation | Number |
|---|---|
| Webhooks that reached the API after the first payment | **9, all rejected 400** (`bad_signature` counter) |
| Log lines about those rejections | **0**: only a counter showed it (fixed: rejections now log a warning) |
| Cause | the secret saved in the Razorpay dashboard ≠ `RAZORPAY_WEBHOOK_SECRET` (re-entering it fixed new events) |
| Retry spacing, one rejected event (`TvQFLJPQvwUJrh`) | **321 s, then 643 s** between deliveries: exponential backoff |
| Old events after the secret was changed | still rejected: Razorpay signs a retry with the secret valid **when the event happened** (as its docs say) |

**Second payment** (`pay_TvQYETyqBv1R6L`, card …1007, redirect mode), with matching secrets:

| Time (UTC) | Event |
|---|---|
| 19:46:17.558 | our payment attempt (Razorpay order) created |
| 19:46:43 | Razorpay's `created_at` for the payment (1 s precision; includes typing the OTP afterwards) |
| 19:46:50.490 | **`payment.captured` webhook received** |
| 19:46:50.548 | processed: order **paid**, stock committed (**58 ms**) |
| 19:46:50.500 → .584 | `order.paid` webhook for the same payment, 10 ms behind, processed concurrently → **duplicate** |
| afterwards | the browser's callback for the same payment → **duplicate** |

The webhook beat the browser. Three messages about one payment; it was counted once.

## E4c — 100 webhooks for one payment, at once

`scripts/e4-webhook-storm.ts`: places a real order (real Razorpay test-mode order), then sends `payment.captured`
signed with our webhook secret (made-up `pay_storm…` id) through NGINX: **(1)** 50 copies of one event id at the same
instant, **(2)** 50 different event ids for the same payment. Check: `payments_total{outcome="paid",source="webhook"}`
before and after.

| Run | (1) same event × 50 | p50 / p95 ms | (2) 50 events, same payment | p50 / p95 ms | "paid" counter |
|---|---|---|---|---|---|
| 1 | 1 paid · **2 processed as duplicate** · 47 answered from the event table | 211 / 218 | 50 duplicate | 132 / 158 | 4 → **5** |
| 2 | 1 paid · 49 from the event table | 199 / 201 | 50 duplicate | 167 / 198 | 5 → **6** |
| 3 | 1 paid · 49 from the event table | 304 / 311 | 50 duplicate | 157 / 190 | 6 → **7** |

Three earlier runs (whose report only printed the outcome) also moved the counter by exactly +1 each (1 → 4).
Every delivery got 200.

- **Exactly one "paid" per 100 deliveries**, in all 6 runs.
- **The event-id table is a shortcut, not the guarantee.** Copies that arrive while the first is still being processed
  pass the "seen this event?" check: 2 in run 1 above, and 0, 1 and 4 in the three earlier runs. The conditional
  UPDATE on the order stopped every one of them (`processed/duplicate`).
- Latency is for 50 requests landing together on one API process; a single delivery took 58 ms (E4b).

## E4d — The payment-timeout job meets 40,307 abandoned orders

On first deploy the database held **40,307 `pending_payment` orders** from the load tests of 2026-10-28 (before
payments existed). The job cancels each (after asking Razorpay, if it had a payment attempt) and releases its stock.

| Version | How it works | Measured |
|---|---|---|
| v1 | one batch of 100 per 30 s round | 800 cancelled in the first ~4 min ≈ **200/min** → ~3.4 h for the backlog |
| v2 | batches of 100 until none are left; 20 s budget per round; stop if a batch changed nothing | 39,807 → 36,236 in 61 s (**3,571/min**); all **39,807 cleared in 18 rounds**, last at 19:40:34 (~8 min) |

- A full round cancelled 2,700–3,300 orders in ~20 s (~7 ms per order: one conditional UPDATE + one stock-release
  transaction). Four rounds did only 600–800 in the same 20 s; not investigated (slow commits on this laptop's
  Docker disk, E3e, are a suspect).
- "Stop if a batch changed nothing" matters: if Razorpay is down, the same oldest orders come back first every time,
  and the job would spin on them for the whole budget.

## E4e — A fixed webhook address (ngrok free static domain), 2026-11-14

The quick tunnel got a new address every run, so the dashboard's webhook URL kept going stale. Now
`infra/tunnel.ps1` runs ngrok 3.39.13 with the account's free fixed domain (`NGROK_DOMAIN` in `.env`) → NGINX :8088.
The dashboard URL was set once.

- Setup gotchas: winget installed ngrok **3.3.1**, which the account refused (minimum agent version **3.29.0**,
  ERR_NGROK_121); `ngrok update` fixed it. Browser-like GETs get ngrok's free-plan warning page (ERR_NGROK_6024);
  server-to-server webhook POSTs don't.
- Unsigned test POST through the tunnel → **400 "invalid webhook signature"** from our API.

Live payment `pay_U0273aytdy2ocM` (card …1007, ₹163.38), times in UTC:

| Time | Event |
|---|---|
| 11:07:09.619 | our order created |
| 11:07:10 | Razorpay order created (1 s precision) |
| 11:07:21 | Razorpay's `created_at` for the payment |
| 11:07:27 | Razorpay's `created_at` for the webhook events |
| 11:07:28.368 | **`payment.captured` received** |
| 11:07:28.482 | processed: order **paid** (order row updated 11:07:28.430), outcome `paid` (**114 ms**; ngrok saw 142 ms round trip) |
| 11:07:28.638 → .656 | `order.paid` for the same payment → **duplicate** (ngrok: 44 ms) |

Both deliveries returned 200, each on the first try (`deliveries = 1`). One run only.

## Correctness tests (fake Razorpay, real HTTP + MySQL)

- `test/payments.e2e-spec.ts`: **43 tests, Fastify and Express**. Pay → webhook → paid + stock committed;
  forged/altered/unsigned webhook → 400, no change; 20 copies of one event at once → paid once; out-of-order
  failed/captured; second payment → refund; wrong amount → refund; unknown provider order → ignored; browser confirm
  (valid / forged / other user / provider down → "processing", webhook settles it); redirect callback (success,
  failure, forged, no open redirect); timeout (cancel + stock back; lost webhook found → paid; provider down → not
  cancelled); late payment → refunded once over two refund rounds; failed refund retried.
- **Mutation checks:** removing `AND status = 'pending_payment'` from "mark paid" → **12 tests failed**; skipping the
  webhook signature check → **2 tests failed**. Both restored → green.
- Unit: Razorpay client (auth header, no body on GET, error parsing, duplicate refund receipt), event parsing,
  signatures.

## Not measured live (yet)

- A **real refund** in Razorpay test mode (late payment or paid twice): only with the fake provider.
- A **lost webhook found by the timeout job** against real Razorpay: only with the fake provider.
- A `payment.failed` webhook **accepted** live. Webhooks from the time of the failed attempts did arrive, but they were
  rejected before parsing (wrong secret), so their event type is unknown.
