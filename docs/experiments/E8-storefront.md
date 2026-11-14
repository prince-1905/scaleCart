# E8 — The storefront: what does the browser download, and is it served right?

**Date:** 2026-11-06 · **Phase:** 5 · **Status:** done (no Lighthouse run yet, see the end)

## Setup

| Item | Value |
|---|---|
| App | `apps/web`: React 19.3, React Router 8.5, TanStack Query 5.106, Tailwind 4.3, Vite 8.3 (Rolldown), TypeScript 7.0 |
| Build | `vite build`, sizes as Vite reports them (raw / gzip) |
| Serving | NGINX 1.30.6 (Compose `lb`), `/shop/` → `apps/web/dist` |

## E8a — Bundle size, and what code splitting actually saved

| Build | JavaScript on first visit (gzip) | CSS (gzip) |
|---|---|---|
| 5a (shop, auth) | 115.7 KB (one file) | 7.2 KB |
| 5b (+ product, cart, orders) | 119.1 KB (one file) | 8.0 KB |
| 5d (+ drops, chat, admin), one file | **123.3 KB** | 8.5 KB |
| **5e, pages split** (product, cart, orders, admin, login load on first visit) | **122.5 KB** (81.3 + 40.9 + 0.4) | 8.5 KB |

Split-off pages: login 1.0 KB, product 1.4 KB, cart 1.8 KB, orders 2.1 KB, admin 2.1 KB (gzip).

- **Splitting saved only ~0.8 KB on the first visit.** Our own page code is small; nearly all of the download is the
  libraries every page needs (React, React DOM, the router, the data cache). Splitting is kept because it costs nothing,
  but the lesson is to **measure before optimizing**: the next real cut would be a lighter framework (e.g. Preact),
  not more splitting.
- Every feature added from 5a to 5d (product, cart, orders, drops, chat, admin) cost 7.6 KB gzip in total.

## E8b — Serving: pages, deep links and caching (checked with curl against `http://localhost:8088`)

| Request | Answer |
|---|---|
| `/shop` | 301 → `/shop/` |
| `/shop/`, `/shop/drops`, `/shop/orders/abc`, `/shop/nope/deep` | 200 `text/html` (the app's index; React Router shows the page) |
| `/shop/assets/index-….js` | 200, `Cache-Control: public, max-age=31536000, immutable` |
| `/shop/` (index.html) | `Cache-Control: no-cache` |
| `/shop/assets/nope.js` | 404 (no fallback for missing files, so a broken deploy fails loudly) |
| `/products?limit=1` | 200: the API keeps its root paths |

Why: file names contain a content hash, so a changed file gets a new name and can be cached "forever". Only
`index.html` (which names the current files) must be re-checked on every visit.

## E8c — Correctness tests (`npm test`, Vitest 5 + Testing Library, fake API)

**14 tests:**
- API client: token sent, no Content-Type on empty bodies, **3 parallel requests with an expired token share 1 refresh**,
  a refused refresh logs out, error codes are exposed
- NDJSON reader: lines **and a ₹ character split across chunks**
- money and countdown formatting
- drops page: countdown, login prompt, **join → ticket and place → automatically "Buy now" when called**, sold out
- cart: logged-out redirect, **checkout sends the expected total + an Idempotency-Key** then starts payment, price change
  shown

**Mutation checks:**
- making every request refresh on its own → the single-flight test failed
- turning off the waiting-room polling → the "Buy now" test failed

Backend: `POST /payments/razorpay/callback?return=shop` redirects to `/shop/orders/:id?payment=…`. Any other value falls
back to `/demo/` (e2e test, including `return=https://evil.example`).

## E8d — The admin area (added 2026-11-12)

Staff now have their own area at `/shop/admin`, with 5 tabs: Overview, Orders, Products, Drops (live monitor) and AI copy.
New admin-only API routes (each checks the admin role in the signed token; customers get 403, tested):
`GET /admin/orders`, `/admin/orders/stats`, `/admin/orders/:id`, `PATCH` / `DELETE /drops/:id`, `GET /drops/:id/stats`.
Also added: `GET /inventory?productIds=…` (public, max 100), which reads the stock of a whole table in 1 call instead of 20.
Admins can no longer join a drop's line (403 `staff_cannot_join_drops`). They can still buy normal products.

**Speed on the running stack (10 calls each, through NGINX, 69,482 orders in the table):**

| Call | Median | Max |
|---|---|---|
| `GET /admin/orders/stats` (counts and money per status) | 129.5 ms | 138.9 ms |
| `GET /admin/orders?limit=25` (newest first) | 4.5 ms | 14.0 ms |
| `GET /admin/orders?limit=25&status=paid` | 3.5 ms | 5.4 ms |

- **Why the stats call is slower:** it reads every order row. EXPLAIN shows a full scan of the index (`type: index`, ~65k
  rows). That's fine for one admin page that refreshes every 10 s. At millions of orders, keep a running total
  instead: a small summary table that the order status changes update, or a cached result.
- **Why the list stays fast:** it uses keyset paging (`id < last id seen`, newest first). Page 500 costs the same as page 1.

**Tests:**
- API: +4 drops e2e tests (staff blocked, edit, cancel only without purchases, live stats) and +3 shop e2e tests on both
  adapters (orders list/stats/detail, paging, batch stock). Totals: 64 unit, 180 e2e.
- Web: +5 tests (customer sent away, overview revenue, product edit sends stock only when changed, drop monitor + cancel
  disabled, the drop page tells staff they can't join). Total: 20.

**Mutation checks (all caught):**
- removing the staff block in the API → its e2e test failed
- always sending the stock on save → the product test failed
- removing the staff message on the drop page → its test failed

Bundle: the admin area is its own lazy chunk (26.5 KB, 7.7 KB gzip). Customers never download it.

## E8e — Bug: "items appear in my cart by themselves" (found by the owner, 2026-11-13)

**Cause:** Buy now on a drop did two things:
1. It put the drop item into the customer's normal cart (`PUT /cart/items/:id`).
2. It checked out the *whole* cart.

So anything already in the cart was bought too. When the attempt failed (sold out, expired pass), the drop item stayed in
the cart. Separately, 897 load-test accounts still held a leftover cart line from the 2026-11-04 load test.

**Fix:**
- `POST /checkout` accepts `buyNow: { productId, quantity }`. The order is made from that one item only, and the cart is
  not read, bought or changed.
- `buyNow` is part of the idempotency fingerprint, so the same key can't be reused for a different item.
- Leftover cart lines were deleted from the dev database: 897 load-test lines, plus 1 stale drop item.

**Proof:**
- e2e test with a cart holding 2 other units: the order holds only the drop item, the cart is unchanged, and so is the
  other product's stock. A losing buyer's cart is also unchanged.
- Mutation check: going back to "whole cart" → the test failed.
- Web test: Buy now sends `buyNow` and makes no `/cart` call.
- Live, on the running stack: a cart with a hoodie, then Buy now on drop #35 → order = `Air Nova Limited Sneakers x1`,
  and the cart still holds the hoodie.

## Not measured yet

- **Lighthouse / Web Vitals** (load time, layout shift, accessibility score): needs the Lighthouse tool installed.
- **Real-browser end-to-end** (Playwright): the flows are covered by component tests and by curl checks, not by an
  automated browser. The owner's manual check in a browser is still to come.
