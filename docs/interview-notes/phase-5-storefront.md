# Interview notes — Phase 5: The storefront (React + Tailwind)

Evidence: [E8 experiment report](../experiments/E8-storefront.md). Code: `apps/web/` ([README](../../apps/web/README.md)).

---

## 1. The 30-second version

> "I built a React + Tailwind storefront on top of the backend: shop, search, product pages, cart, Razorpay checkout,
> order tracking, a live drops page with the waiting room, an AI chat bubble and an admin page. The interesting parts are
> where the frontend has to respect the backend's guarantees. **Token refresh is single-flight**, because the API rotates
> refresh tokens and treats reuse as theft. **Checkout keeps one Idempotency-Key per attempt**, so a double click can't
> create two orders. **The drop countdown uses the server's clock**, not the visitor's. The whole app is ~122 KB gzip of
> JavaScript, and code splitting saved under 1 KB, because the libraries are the weight, not our pages."

---

## 2. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **SPA (single-page app)** | One HTML page; JavaScript swaps the views | A shop where the shelves move to you |
| **Client-side routing** | `/shop/drops` is drawn by React, not fetched as a new page | Changing channels without a new TV |
| **Server state cache** (TanStack Query) | Fetched data kept, refreshed in the background, polled when needed | A notice board that updates itself |
| **Single-flight** | Many callers, one request in progress, all share the answer | One person queues for the whole group |
| **Code splitting** | Pages downloaded on first visit, not up front | Unpacking a suitcase room by room |
| **Content-hashed assets** | File name changes when content changes, so it can be cached for a year | A new label on every new batch |
| **Streaming (NDJSON)** | The answer arrives line by line | Subtitles appearing as people speak |

---

## 3. The stories

### Story A — "Two tabs, one expired token: why my refresh is single-flight" ⭐
- The API **rotates** refresh tokens: each use returns a new one and kills the old. Reusing an old one means theft, so the
  API revokes the whole family and logs the user out.
- A page loads cart + orders + profile at once. With an expired access token, all three get 401. If each refreshed on its
  own, the 2nd and 3rd would reuse the same token and the user gets kicked out.
- **Fix:** one shared refresh promise. **Test:** 3 parallel requests → exactly 1 refresh, all 3 retried. A mutation
  (refresh per request) made the test fail.

### Story B — "The frontend's part in 'never charge twice'" ⭐
- The backend makes checkout idempotent (Phase 1). The frontend has to **reuse the same key on a retry**, and only make a
  new one after a definite answer.
- It also sends `expectedTotalCents`. If a price changed while you looked at the cart, the API refuses (`409
  price_changed`) instead of charging a different amount. Both are covered by tests.

### Story C — "A countdown you can't cheat"
- The countdown runs on **server time**: the API sends `serverTime` and the page keeps the offset. A visitor's wrong clock
  can't make it look started.
- The rule itself lives on the server: checkout needs a signed pass. **The UI is a display, the API is the rule.**
- The place in line refreshes **as often as the API's estimate suggests** (1–5 s), and stops once your number is called.

### Story D — "I split the bundle and measured almost nothing"
- 123.3 KB → 122.5 KB gzip for the first visit. Pages are 1–2 KB each; React + router + query are the weight.
- **Lesson:** measure first. The next real step would be a lighter runtime (Preact), or serving the first view from the
  server.

### Story E — "Serving an SPA under a path, next to an API"
- The API owns `/products`, `/cart`… so the shop lives under `/shop/`. NGINX:
  - serves `index.html` for any `/shop/…` page
  - caches hashed assets for a year
  - never caches `index.html`
  - returns 404 for a missing asset, instead of silently serving HTML
- In development, Vite forwards every non-`/shop` path to the API: same origin, no CORS.
- **Payment return:** after Razorpay, the API redirects to a page **chosen from a fixed list** (`return=shop`), never a URL
  from the request (no open redirect, tested).

### Story F — "The admin area: the role is checked by the API, not the menu" ⭐
- **Problem:** the admin logged in and saw the same shop as a customer. They could even join a drop's line and take
  limited stock.
- **Fix:**
  - A staff area with 5 tabs: overview (revenue counts paid orders only), every customer's orders, products + stock,
    drops with a live monitor, AI copy.
  - New admin-only routes. **The API checks the role inside the signed token on every call.** Hiding the menu link is
    only cosmetic.
  - Staff can't join drops (403 `staff_cannot_join_drops`). Limited stock is for customers, and the UI says so up front.
- **Proof (E8d):** the order list takes ~4 ms (keyset paging). The stats query takes ~130 ms, because it reads all 69k orders.
- **Trade-off:** that is fine for one admin screen. At scale, keep running totals instead of counting on every refresh.
- **Live monitor:** the drop's line comes from Redis (tickets, called, shopping). Purchases and stock come from MySQL.
  Each number comes from the system that owns it.
- **Cancelling a drop:** refused (409) once anyone has bought in it, because those orders belong to the drop.

### Story G — "Buy now bought my whole cart"
- **Bug:** Buy now put the drop item in the shared cart and checked out the whole cart. Old cart items were bought along
  with it, and a failed attempt left the drop item behind ("items appear by themselves").
- **Fix:** checkout takes `buyNow: { productId, quantity }`. The order is made from that item alone, and the cart is
  never touched.
- **Lesson:** two features shared one piece of state (the cart) that only one of them owned. A failed attempt must leave
  nothing behind.
- **Proof:** e2e and web tests (mutation-checked), plus a live check (E8e).

---

## 4. Likely follow-up questions

**Q: An admin edits a price. What happens to orders already placed?**
Nothing. Order lines copy the name and price at checkout. The shop's product cache shows the new price within its TTL,
and checkout always prices from MySQL (`expectedTotalCents` catches a change the shopper didn't see).

**Q: Why can't staff join drops?**
It's a fairness rule. Staff accounts could otherwise take scarce stock before customers do. It is enforced in the API, not
only by hiding the button.


**Q: Why TanStack Query and not Redux?**
Almost all our state is *server* state (cart, orders, drops). Query handles caching, refetching, polling and
invalidation ("cart changed → refetch"). The little client state (forms, the chat) lives in components.

**Q: Where would you store tokens in production?**
The refresh token in an HttpOnly, SameSite cookie, so page scripts can't read it (XSS can't steal it). The access token in
memory. That needs a small API change (set the cookie, CSRF protection). localStorage is a documented demo trade-off.

**Q: How do you stop XSS from the AI's text?**
React escapes everything it renders. The chat shows model text as text, never as HTML.

**Q: How would you test it end to end?**
Playwright against the Compose stack: log in, add to cart, checkout with a fake payment provider. Not built yet; the flows
are covered by component tests with a fake API.

---

## 5. Self-quiz

1. Why must the token refresh be single-flight in this app specifically?
2. When does the cart create a new Idempotency-Key, and when does it reuse one?
3. Why does the drops page use the server's clock, and what still enforces the start time?
4. Why did code splitting save so little here?
5. Why is `index.html` never cached, but the JS files are cached for a year?
6. The admin link is hidden from customers. Is that the security? What is?
7. Why does the order-stats call take ~130 ms while the order list takes ~4 ms?

<details><summary>Answers</summary>

1. The API rotates refresh tokens and revokes the family when one is reused. Parallel refreshes would reuse the same token
   and log the user out.
2. It reuses the key for retries of the same attempt (network error, double click). It starts a new one only after a
   definite answer: success, or a 4xx such as sold out or price changed.
3. Visitors' clocks can be wrong. The API enforces the start: checkout needs a pass, and passes are only issued after the
   start.
4. The libraries (React, router, query) are ~120 KB of the ~122 KB. Each page is 1–2 KB.
5. File names contain a content hash, so a changed file has a new name. index.html is the one file that points to the
   current names, so it must be fresh.
6. No, hiding the link is cosmetic. The API checks the admin role inside the signed token on every admin route
   (customers get 403, tested).
7. Stats counts every order (a full index scan, ~69k rows). The list reads 25 rows from an index with keyset paging.
   At scale, keep running totals instead of counting.
</details>
