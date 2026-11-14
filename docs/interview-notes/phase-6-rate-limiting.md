# Interview notes — Phase 6: Rate limiting (token bucket in Redis + NGINX edge)

Evidence: [E9 experiment report](../experiments/E9-rate-limiting.md). Code: `apps/api/src/rate-limit/`,
`infra/nginx/nginx.conf` (`limit_req`).

---

## 1. The 30-second version

> "I added an API-wide **token bucket** per caller in Redis: one Lua script, so all pods share the bucket and two
> requests can't both take the last token. Then I measured it against one scraper doing 1,500 searches a second while 50
> shoppers browsed. **Without a limiter**, 1,000–2,000 of the shoppers' 3,000 requests failed. **With it**, far fewer
> failed, but shoppers still waited seconds: refusing 1,500 requests a second kept Node's one CPU 100% busy, and when
> Redis replies came back late my 'fail open' rule let **18,373** attacker requests in. So I added a cheap **edge limit in
> NGINX** and a **local backup bucket** in each pod. Shoppers then got the same latency as with no attacker (p95 7 ms),
> in 3 of 4 runs. The first baseline also caught a bug: logged-in shoppers on public pages were counted by IP."

---

## 2. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Rate limiting** | Cap how many requests one caller may send per second | A bouncer letting each person in so often |
| **Token bucket** | Bucket holds up to *capacity* tokens, refills at *rate*/s; each request takes one | A coffee card: one stamp every few seconds, at most 20 stamps |
| **Burst vs steady rate** | Capacity = biggest burst after being quiet; refill = long-run speed | Saving stamps for a busy morning |
| **Lazy refill** | No timer: add *time passed × rate* when the next request comes | Counting stamps owed when the customer shows up |
| **429 + Retry-After** | "Too many requests", and how many seconds to wait | "Come back in 3 seconds" |
| **Fail open / closed** | If the limiter can't decide: allow everyone / refuse everyone | Bouncer missing: door open / door locked |
| **Edge limit** | Refuse at the proxy/gateway, before the app does any work | A turnstile outside the shop, not a clerk inside |

**Other algorithms (know the differences):**
- **Fixed window** (our login limiter: 5 per 15 min): simple, but allows 2× at a window boundary.
- **Sliding window log / counter:** smoother, with more memory or more maths.
- **Leaky bucket:** smooths the output to a constant rate; a queue rather than a burst allowance.
- **Token bucket:** allows bursts and caps the average. Good for APIs, where pages load several things at once.

---

## 3. The stories

### Story A — "My limiter limited the wrong people" ⭐
- **Symptom:** baseline with no attacker → **1,119 of 3,000** shopper requests got 429.
- **Cause:** public routes (product page, search) skipped reading the token, so 50 logged-in shoppers were counted as one
  IP (20/s for 50/s).
- **Fix:** on public routes, a valid token still identifies the user; a bad token is ignored.
- **Proof:** 0 refused after the fix. The new test fails without it.
- **Lesson:** who you count by matters as much as how you count. Offices and mobile carriers put thousands of people
  behind one IP.

### Story B — "Saying no isn't free" ⭐
- **Proof:** with the app limiter on, the attacker was refused ~70k times, yet the event loop was 100% busy and shoppers'
  p95 was 4.5–10 s.
- **Why:** each refusal still costs an HTTP parse, a JWT check, a Redis round trip and an error response in Node.
- **Fix:** NGINX `limit_req` keyed by the token refuses floods in **~0.6 ms** without touching Node.
- **Result:** shoppers p95 **7.0–7.2 ms** (no attacker: 9.8 ms); API event loop 20–26% busy (3 of 4 runs).
- **Layering:** a cheap, coarse limit at the edge (50/s per token) plus a precise one in the app (20/s per user,
  per-policy, shared in Redis).

### Story C — "Fail open betrayed me under load" ⭐
- **Design:** if Redis doesn't answer in 200 ms, allow the request, the same choice as the cache.
- **What happened:** under the flood, Redis was healthy but the API was too busy to read its replies in time. So the
  limiter switched off **exactly when it was needed most**: 18,373 leaked requests.
- **Fix:** fall back to a **local in-memory bucket** per pod. Trade-off: N pods give up to N × the limit while Redis is
  out, which is still a limit.
- **Result:** the backup decided ~1,300 requests in the one run with stalls; attacker searches served fell to 804, where
  fail open had let 7–10 thousand through.

### Story D — "Why Redis, why Lua?"
- **Shared:** every pod sees the same bucket. With per-pod memory, a user would get N × the limit by hitting different
  pods. Test: two API instances, 10 requests alternating → still exactly 5 allowed.
- **Atomic:** read, refill, take and save in one script, so 50 parallel requests against 10 tokens → exactly 10 allowed.
- **One clock:** the script uses Redis `TIME`, so pods with different clocks agree. If the clock steps back, elapsed
  counts as 0.
- **Cheap:** one round trip, and the key expires once the bucket would be full again, so idle users cost no memory.

---

## 4. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| Per user when logged in, per IP otherwise | Shared IPs don't block each other | A logged-out flood from many IPs isn't stopped (needs CDN/WAF) |
| Policies: default 60:20, auth 10:0.2 per IP, checkout 5:0.5 | Expensive or abusable routes get smaller buckets | Numbers are guesses to tune with real traffic |
| Edge key = token | Like a gateway keyed by API key; testable on one laptop | Random fake tokens each get a fresh NGINX bucket (the API still limits them per IP) |
| Local fallback instead of fail open | Keep a limit when Redis is slow | Up to N × limit with N pods while Redis is out |
| Limiter off in tests, k8s and old load tests | They send everything from one IP | Must remember `RATE_LIMIT_ENABLED=false` for older experiments |

---

## 5. Likely questions

1. **Token bucket vs leaky bucket?** The token bucket allows bursts up to the capacity and caps the average. The leaky
   bucket outputs at a constant rate, queueing or dropping the rest. APIs want bursts: one page load = several calls.
2. **Where would you rate-limit in production?** In layers. CDN/WAF per IP for floods and bots; API gateway per API
   key/token; the app per user and per route for business rules (checkout, login). Here: NGINX plus the app.
3. **What happens if Redis goes down?** Each pod limits on its own bucket in memory; the metric shows `source="local"`.
   Money paths never depend on it, because stock and orders are protected by MySQL.
4. **How do you pick the numbers?** Measure normal use (a page load = how many calls?), set the limit well above it,
   alert on 429 rates per route, and tune. Our E9 baseline showed real shoppers at ~1 req/s against a 20/s limit.
5. **How does a client know when to retry?** `Retry-After` in seconds, computed from tokens missing ÷ refill rate. Good
   clients back off with jitter.
6. **Why not limit in Node memory only?** With several pods each one counts separately, so a user gets N × the limit.
   Redis gives one shared count; memory is only the backup.
7. **What did you get wrong first?** Counting shoppers by IP on public pages, and failing open under load. Both were
   found by measuring, and both now have tests.

---

## 6. Self-quiz

1. A bucket has capacity 10 and refills 2 tokens/s. A user is quiet for a minute and then sends 15 requests at once.
   How many succeed?
2. Why does the Lua script use Redis `TIME` instead of the API's clock?
3. In E9b, why were shoppers still slow even though the attacker was refused?
4. What does `source="local"` in `rate_limit_total` mean, and when did it show up?
5. Why is the NGINX limit (50/s) looser than the app's (20/s)?
6. Name one way an attacker can still get around our edge limit, and what would stop it.

<details><summary>Answers</summary>

1. 10: the bucket caps at 10, then refills 2/s.
2. One clock for all pods, so the refill maths agrees, and the read-refill-take happens atomically in one place.
3. Refusing still cost Node CPU (JWT check, Redis call, error response) at 1,500/s, and fail open leaked 18,373 requests
   when Redis replies came back late.
4. Redis didn't answer in time and the pod's in-memory bucket decided. It showed up only in the bad run, during the
   laptop's stalls (~1,300 decisions).
5. NGINX is the coarse safety net that only stops floods; the app's per-user limit is the precise one, so normal users
   never meet the edge limit.
6. Send random fake tokens or no token: each fake token gets a fresh NGINX bucket. A per-IP limit at the CDN/WAF, or
   validating tokens at the gateway, would stop it.

</details>
