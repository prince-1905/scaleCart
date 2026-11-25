# Interview notes — Phase 13: MySQL read replica

Evidence: [E16 experiment report](../experiments/E16-read-replica.md). Plan: [phase-13 plan](../plans/phase-13-read-replicas.md).
Code: `apps/api/src/database/read-replica.ts` (routing, lag guard, read-your-writes, bulkhead),
`apps/api/src/orders/replication-heartbeat.ts`, `infra/mysql/replica/setup-replica.sh`, `docker-compose.yml`
(`mysql-replica`, `replica-setup`).

---

## 1. The 30-second version

> "One MySQL did everything: checkout's writes and every browsing read, including an admin dashboard that scans all
> orders. I added a read replica, a read-only copy kept in sync by MySQL's binary log, and moved only the reads that
> may be a moment old: product lists, order history, the dashboard. At a moderate load the primary's CPU went from
> about 83% to about 23%. Then I measured the classic bug: right after checkout, 18 to 76 of 100 customers didn't see
> the order they had just placed, because the copy was a few milliseconds behind. I fixed that with GTIDs: the shop
> remembers the customer's latest transaction and asks the replica to wait for it, at most 50 ms, else reads the
> primary. 0 of 194 missed, at an average cost of 0.8 ms. And the load test found a cascade: an overloaded replica
> looked 'down', all its reads moved to the primary, and checkouts timed out. A bulkhead fixed it: checkout p50 went
> from 30 s to 0.7 s at that load."

---

## 2. The user's view

| I am… | What happens now | Measured |
|---|---|---|
| A buyer at checkout | My checkout's database isn't busy with dashboards and browsing | Primary CPU 19–27% instead of 82–84% (moderate load) |
| A buyer who just ordered | "My orders" shows my order at once | 0 of 194 missed (without the fix: 18–76 of 100) |
| A shopper browsing | Pages come from the copy | A copy 4–13 ms behind (p50, idle) |
| A shopper while the copy is down | Pages still load, from the main database | 2,506 of 2,516 answered, the rest a quick "busy" |
| A shopper when everything is overloaded | I may get "busy, try again" on browsing | ~4,100 quick 503s per heavy run; checkouts kept working (p50 0.6–0.7 s instead of 30 s) |
| An admin on the dashboard | The numbers can be a few ms old | Stats p50 0.45–0.9 s instead of 15–22 s (heavy load) |

---

## 3. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Read replica** | A copy of the database that applies the primary's changes; serves reads only | A photocopy of the ledger at the front desk |
| **Binary log (binlog)** | The primary's list of every committed change, in order | The ledger's change journal |
| **Async replication** | The primary doesn't wait for the replica: fast writes, but the copy lags | The photocopy is reprinted after each page, not before |
| **Replication lag** | How far behind the copy is | How old the photocopy is |
| **GTID** | A global id per transaction (`server-uuid:number`): "which changes do you have?" is exact | A numbered receipt for every change |
| **Read-your-writes** | A user always sees their own latest write, even when others may read slightly old data | After paying, the cashier checks the original, not the copy |
| **`WAIT_FOR_EXECUTED_GTID_SET`** | "Replica, wait until you've applied these transactions (max N s)" | "Is my receipt on the copy yet? I'll wait a moment" |
| **Heartbeat** | A timestamp written to the primary and read from the replica: now − stamp = lag | A clock photographed into every copy |
| **`super_read_only`** | Even admins can't write to the replica, so it can't drift | The photocopy is laminated |
| **Clone plugin** | Copies a whole MySQL server over the network to start a replica | Photocopying the entire ledger once |
| **Bulkhead** | Cap how much of the primary the fallback may use | Watertight compartments |

---

## 4. How it fits together

```
writes, cart, checkout, prices ───────────────► PRIMARY ──binlog──► REPLICA (read-only, ms behind)
product lists, dashboard, search fallback ──► healthy? ──yes─────────────────┘
                                               └─no (behind > 2 s / down) → primary, max 4 at once, else 503
"My orders" (after my checkout) ──► replica has my GTIDs within 50 ms? yes → replica, no → primary
worker: heartbeat every 250 ms → shop checks the replica's copy of it every second
```

---

## 5. The stories

### Story A — "I just ordered but My orders is empty" ⭐
- Proof: 100 checkouts each followed at once by "My orders" from the replica: **18 and 76 of 100 missed** (two runs).
  Lag was only milliseconds, but the next request is faster.
- Fix: after checkout, save the primary's `gtid_executed` for that customer (Redis, 10 s). Their order reads ask the
  replica `WAIT_FOR_EXECUTED_GTID_SET(gtids, 0.05)`: caught up → replica, else primary.
- Result: **0 of 94 and 0 of 100** missed; average wait **0.8 ms**; all those reads still came from the replica.
- Trade-off: one extra primary query per checkout + a Redis key; Redis down → read the primary (safe).

### Story B — "The replica fell over and took the primary with it" ⭐
- Heavy dashboard load: the replica hit its CPU limit, its health check timed out, the shop marked it "down" and
  moved its reads to the primary. Primary 155–190%: checkouts timed out (p50 22–29 s), no better than no replica.
- Fix: bulkhead. Fallback reads may use at most 4 primary connections at once; the rest get a quick 503.
- Result at the same load: primary 105–117%, **checkout p50 0.6–0.7 s**; the cost is ~4,100 quick 503s on browsing.
- Same lesson as E15 (search): a fallback must be smaller than the thing it protects.

### Story C — "How much did it offload?"
- Moderate load (browsing + order history + 3 dashboard scans/s + checkouts): primary CPU **82–84% → 19–27%**; the
  replica took 78–98%.

### Story D — "Which reads stay on the primary, and why"
- Money: prices, stock, cart, checkout, payments. A copy even 1 s old could charge an old price.
- The product-page **cache fill**: after an edit the cache entry is deleted; refilling it from a copy a few ms behind
  would store the OLD product for the whole 60 s TTL. (Cache + replica = staleness multiplied.)

### Story E — "Measuring lag honestly"
- Heartbeat for the guard (every 250 ms → ±0.25 s resolution); markers for the experiment (back-to-back polls).
- A trap: `sleep(2)` sleeps ~14 ms on Windows, which made the first measurement look 4× worse.
- Idle lag p50 4.4–12.7 ms, p99 20–86 ms: about one disk-synced commit on the replica.

---

## 6. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| Async replication | Writes don't wait for the replica | The copy lags; read-your-writes needed |
| Explicit routing, not TypeORM's automatic `replication` | Automatic would send every non-transaction SELECT to the replica, price reads included | Each routed read is chosen in code |
| Heartbeat lag guard (2 s) | Stale beyond 2 s isn't acceptable for browsing | Reads move to the primary when behind (bulkhead-limited) |
| GTID wait for a customer's own reads | Exact: "has the copy got MY write?" | One query per checkout, a Redis key, ≤ 50 ms wait |
| Bulkhead 4 on fallback reads | Protect checkout's database | Quick 503s on browsing when the replica can't serve |
| Cache fills from the primary | No old data pinned for 60 s | Cache misses still load the primary |
| No automatic failover | Out of scope on one laptop | Primary down = shop down (the replica can't take writes) |

---

## 7. Likely questions

1. **Why not just a bigger primary?** Vertical scaling has a ceiling and doesn't isolate: one heavy dashboard scan
   still competes with checkout. A replica separates read traffic from writes.
2. **Sync or async replication?** Async: the primary doesn't wait, so writes stay fast; the copy may be behind.
   Semi-sync waits for one replica to receive (not apply) each transaction: safer for failover, slower commits.
3. **How do you stop stale reads?** Only route reads that tolerate staleness; for a user's own data use
   read-your-writes (GTID wait, or read the primary for N seconds after a write).
4. **What if the replica falls behind or dies?** The lag guard sends reads to the primary, limited by a bulkhead so
   the primary isn't flooded; the replica catches up by itself (GTID auto-position).
5. **Can the replica be written to by mistake?** No: `super_read_only`, even root gets ERROR 1290.
6. **What if the primary dies?** Not handled: you'd promote the replica (failover), point writes at it, and rebuild a
   new replica. Tools: orchestrator, MySQL InnoDB Cluster, or a managed database.
7. **How many replicas?** Add more for more read capacity; a load balancer (ProxySQL) in front. Each adds binlog
   traffic and connections.

---

## 8. Self-quiz

1. Why did 18–76% of customers not see their new order, when the replica was only milliseconds behind?
2. What does `WAIT_FOR_EXECUTED_GTID_SET` do, and why is it better than "always read the primary after a write"?
3. Why does the product-page cache fill from the primary, not the replica?
4. How did an overloaded replica make checkout time out, and what fixed it?
5. Why can't anyone write to the replica, and why does that matter?
6. Which reads must never use the replica?

<details><summary>Answers</summary>

1. The "My orders" request arrives a few ms after checkout's response, sooner than the replica applies the change.
2. It waits until the replica has exactly the customer's transactions (max 50 ms), so the read can still use the
   replica (0.8 ms average wait); "always primary" would move every after-write read to the primary.
3. A deleted cache entry refilled from a slightly old copy would keep the old product for the whole TTL (60 s).
4. Its health check timed out, it was marked "down", and all its reads went to the primary (CPU 155–190%). A bulkhead
   (max 4 fallback reads at once, the rest 503) kept the primary at ~110% and checkout p50 at 0.6–0.7 s.
5. `super_read_only=ON`: writes there would make the copy differ from the primary and break replication.
6. Writes and money reads: prices, stock, cart, checkout, payments (and the cache fill).

</details>
