# ScaleCart storefront (`apps/web`)

React 19 + Tailwind 4 + Vite. Talks to the ScaleCart API on the same origin; lives under **/shop/**
(the API keeps its root paths: `/products`, `/cart`, `/drops`…).

## Run it

```powershell
docker compose up -d            # the API and NGINX on :8088 (repo root)
cd apps/web
npm install
npm run dev                     # http://localhost:5173/shop/  (proxies every non-/shop path to :8088)
```

Production-style: `npm run build`, then NGINX serves `apps/web/dist` at **http://localhost:8088/shop/**
(`infra/nginx/nginx.conf`: hashed assets cached for a year, `index.html` never cached, SPA fallback).

`npm run lint` · `npm test` (Vitest + Testing Library, fake API, no server needed)

## Pages

| Path | What |
|---|---|
| `/` | Hero, next drop with countdown, categories, newest products |
| `/products` | Search, category chips, sort (all in the address bar, so links can be shared) |
| `/products/:id` | Product, live stock, quantity, add to cart |
| `/drops` | Countdown on the server's clock, join the line, live place in line, Buy now with the pass |
| `/cart` | Quantities, checkout (Idempotency-Key + expected total), Razorpay (redirect mode) |
| `/orders`, `/orders/:id` | History; payment result; "pay within mm:ss" |
| `/admin` | Create drops, AI product copy (review before saving) — admins only, enforced by the API |
| 💬 | AI shopping assistant, streamed (NDJSON) |

## How it's built

- **Server data:** TanStack Query (caching, refetch, polling the waiting room as often as the API's estimate says).
- **Login:** access + refresh tokens in `localStorage` (demo trade-off; production would use an HttpOnly cookie).
  The refresh is single-flight: the API rotates refresh tokens and treats a reused one as theft.
- **Checkout:** one `Idempotency-Key` per attempt, kept across retries, so a double click can't create two orders.
- **Payments:** Razorpay Checkout in redirect mode; the API's `/payments/razorpay/callback?return=shop` sends the browser
  back to `/shop/orders/:id?payment=…`. The order is settled by Razorpay's webhook either way.
- **Pictures:** the catalog has no images, so each product shows its category's emoji on a gradient.
