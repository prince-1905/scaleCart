# Interview notes — Phase 12: Search engine + CQRS (OpenSearch next to MySQL)

Evidence: [E15 experiment report](../experiments/E15-search-cqrs.md). Plan: [phase-12 plan](../plans/phase-12-search-cqrs.md).
Code: `apps/api/src/catalog/search/` (`product-search-index.ts`, `product-indexer.ts`), `apps/api/src/catalog/catalog.service.ts`
(search, fallback, bulkhead, outbox write), `apps/api/src/reindex.ts`, `apps/api/src/orders/outbox-relay.ts` (relays the
catalog outbox too).

---

## 1. The 30-second version

> "Search ran on MySQL FULLTEXT. It found nothing for a typo, so 'sneeker' was an empty page, and it was expensive:
> 50 searches a second used more than a full MySQL core, the same MySQL checkout needs. I added OpenSearch as a
> read-only copy, kept in sync with events: a product edit writes the row and an outbox note in one transaction, the
> worker relays it through RabbitMQ, and an indexer copies the latest row into OpenSearch. That's CQRS: one model to
> write, another to read. Quality went from 9 of 20 test queries to 20 of 20, and MySQL's CPU at 50 searches/s from
> over 100% to about 5%. The interesting part was the failure test: at 200 searches/s OpenSearch overloaded, the
> breaker sent everything to MySQL, and the backup took MySQL down too. I fixed that with a bulkhead: at most 4
> fallback searches at once, the rest get a quick 'busy'."

---

## 2. The user's view

| I am… | What happens now | Measured |
|---|---|---|
| A shopper who typed "sneeker" | I see sneakers | Typos 9 of 9 found (MySQL: 0 of 9) |
| A shopper typing "black jac…" | Results while I type | Unfinished words 3 of 3 |
| A shopper opening the filter sidebar | Counts per category and price | p50 12–18 ms (MySQL 32–72 ms) |
| A buyer during heavy search traffic | Checkout's database isn't busy with searches | MySQL CPU ~4.5% at 50 searches/s (FULLTEXT: 100–124%) |
| A shopper while OpenSearch is down | Search still works (exact words only) | 97–99% answered, rest a quick 503, 0 × 500 |
| An admin who edited a product | Search shows the change a moment later | p50 0.8 s, p95 1.2–1.4 s (20 of 20, ×2) |
| A shopper adding to cart while OpenSearch is down | The cart keeps working | Before a fix: ~30 failed per run; after: 0 |

---

## 3. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Search engine (OpenSearch)** | A database built for text search: inverted index, typo tolerance, ranking, facets | The index at the back of a book |
| **Inverted index** | word → list of products that contain it | "sneaker: pages 4, 19, 302" |
| **Analyzer** | Turns text into searchable words: lowercase, plural → singular ("jackets" → jacket) | Filing every word under its dictionary form |
| **Fuzzy matching** | Allows 1–2 letters wrong (edit distance) | A clerk who understands "sneeker" |
| **Facets** | Counts per category / price range for the current search | "Shoes (412), Bags (37)" in the sidebar |
| **CQRS** | Separate the model you write (MySQL, the truth) from the model you read (OpenSearch, a copy built for queries) | Warehouse ledger vs shop-window catalog |
| **Eventual consistency** | The copy is a moment behind the truth | The catalog is reprinted after each change note |
| **Alias switch** | Searches use a name (`products`) that points at a real index; rebuild a new one, move the name in one step | Swap the sign on the door, not the shop |
| **Circuit breaker** | After 5 failures, stop calling OpenSearch for 10 s | A fuse |
| **Bulkhead** | Cap how much of a resource one path may use (4 fallback searches at once) | Watertight compartments in a ship |
| **Cascading failure** | One overloaded part pushes its load onto the next and takes it down | Traffic diverted from a jammed highway jams the side streets |

---

## 4. How it fits together

```
admin edit ─► MySQL: product row + outbox "product.changed" (one transaction)
                    │
worker relay ───────┴─► RabbitMQ search.product-changes ─► indexer: read product FRESH from MySQL ─► OpenSearch
                                                                     (gone → delete; repeat/old event → same result)
GET /products/search ─► breaker ─► OpenSearch ──(fails / breaker open)──► MySQL FULLTEXT, max 4 at once, else 503
GET /products/search/facets ─► own breaker, 3 s timeout ─► one aggregation query
cart, checkout, prices ─► MySQL only
re-index job ─► new index ─► copy 200k in batches ─► alias switch ─► catch-up of edits made meanwhile ─► delete old
```

---

## 5. The stories

### Story A — "The backup took the database down" ⭐
- **Setup:** OpenSearch with MySQL as the fallback behind a circuit breaker. Sounds safe.
- **What happened at 200 searches/s:** OpenSearch's one CPU was full (fuzzy query: each word expanded into up to 50
  similar terms), requests timed out, the breaker sent them to MySQL, and MySQL hit **165–185% CPU**: the slower engine
  got the whole load. 5,133–7,707 search errors, and the cart (another database on the same MySQL) slowed to p95
  0.6–0.9 s.
- **Fix:** (1) a cheaper query (first letter must match, at most 20 expansions); (2) a **bulkhead**: at most 4 fallback
  searches at once, the rest get a fast `503 search_busy`.
- **After:** when OpenSearch still couldn't keep up, MySQL stayed at 55% instead of 165–194%; the errors were quick
  503s. A fallback must be smaller than the thing it protects.

### Story A2 — "My circuit breaker fought itself" ⭐
- More 200/s runs were worse, not better: the log said "breaker is now open" **2,362 times** in one run.
- Bug: hundreds of searches are in flight when it opens; each late timeout counted as a new failure, re-opened it and
  restarted the 10 s timer. Late answers also freed the half-open trial slot.
- Fix: a generation number, +1 per opening; only calls started since the last opening count. 5 opens per run after.
  Unit tests fail on the old code.
- Honest result: 200/s is the edge for one OpenSearch CPU: 4 of 6 runs clean, 2 tipped into breaker cycles.

### Story A3 — "A dead search engine broke the cart, not the database" ⭐
- OpenSearch stopped at 200 searches/s: ~30 cart requests per run failed, with MySQL at only 53–79% CPU, whatever
  the bulkhead size. Logs: the MySQL driver's `connect ETIMEDOUT`.
- Cause: looking up the name of a stopped container takes Docker 4 s. Node does lookups on 4 shared threads: ~200
  searches clogged them, and the cart's new MySQL connections waited behind and timed out.
- Fix: concurrent lookups of one name share one real lookup, kept briefly (failure 2 s). After: **0 cart failures**.
- Lesson: failures travel through shared resources you don't think about (here, a thread pool).

### Story B — "Typos and the sweater problem" ⭐
- MySQL: 9 of 20 test queries (0 of 9 typos). OpenSearch: 20 of 20.
- Tuning trade-off: the default fuzziness let "sneaker" match "sweater" (2 letters apart): 16,005 matches instead of
  8,004. Stricter (`AUTO:4,8`) broke "woo swea". `AUTO:3,8` kept 20/20 and 8,004. Precision vs recall, measured.

### Story C — "Facets tripped the search breaker"
- Facets shared the breaker and the 1 s timeout with search. A few slow aggregations opened the breaker and
  **plain searches** went to MySQL too. Fix: separate breaker, longer timeout. Lesson: one breaker per kind of call.

### Story D — "Rebuild 200k products with no downtime"
- New index, copy in batches, one atomic alias switch, catch-up. Under 50 searches/s: 565 of 565 ok, 8.7 s (a cold
  first run: 37 s, 74 quick 503s while OpenSearch was busy copying). The switch itself: 0 errors.

### Story D2 — "How fresh is the copy?"
- Admin edit → visible in search: p50 0.8 s, p95 1.2–1.4 s. Parts: outbox poll (200 ms) + queue + indexer (~80 ms)
  + OpenSearch's 1 s refresh.
- A burst of 50 edits found something else: committing them took up to 19.8 s (trace: outbox INSERT 4.3 s,
  UPDATE 1.8 s waiting). Noted as a follow-up.

### Story D3 — "Kong remembered old addresses"
- After recreating containers, Docker swapped their IPs and Kong kept the old ones (Docker's DNS TTL is 600 s): logins
  went to the shop's port; still failing after 60 s. `KONG_DNS_VALID_TTL=5` → back in 17–37 s.

### Story E — "My load generator lied"
- My ops script ran docker with a blocking `execSync`: Node's event loop stopped, no requests were sent during the
  operation, then all of them at once. That burst looked like a slowdown in E14. Fixed with async `exec`; E12/E14
  corrected. Lesson: check the load generator before trusting a strange result.

---

## 6. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| OpenSearch (not Meilisearch / Typesense) | Industry standard (Elasticsearch API), aggregations, alias re-index | Heavy JVM (512 MB heap, 52 s to start) |
| Indexer reads MySQL, not the event's data | Old or repeated events can't put stale data in | One extra MySQL read per change |
| Outbox, not "write MySQL then call OpenSearch" | No lost updates if OpenSearch or the queue is down | The copy is a moment behind |
| MySQL fallback with a bulkhead | Search survives OpenSearch outages without sinking checkout | Fallback is worse (exact words) and some searches get 503 |
| `prefix_length 1`, `max_expansions 20` | Typo matching affordable at 200/s | First-letter typos not forgiven |
| Money never from the copy | Prices and stock always from MySQL | Search can show a price a moment old |
| One node, no replica | One laptop | OpenSearch down = fallback mode |

---

## 7. Likely questions

1. **Why not just MySQL FULLTEXT?** No typo tolerance, crude ranking, expensive facets, and it runs on the database
   checkout needs. Measured: 9/20 vs 20/20, and >100% MySQL CPU at 50 searches/s.
2. **How do you keep them in sync?** Transactional outbox → RabbitMQ → indexer that reads the latest row. No dual
   write, so a crash between "save" and "index" can't lose the update; retries are safe because indexing is idempotent.
3. **What if events arrive out of order?** The event only says "product 42 changed"; the indexer reads product 42's
   current row. The last one to run writes the newest data.
4. **What if the index gets corrupted or you change the mapping?** Re-index into a new index and switch the alias.
5. **How stale can search be?** Measured: p50 0.8 s, p95 1.2–1.4 s (outbox poll + queue + indexing + OpenSearch's
   1 s refresh). Lower the refresh interval or the poll to go faster, at more indexing cost.
6. **Why does checkout not use OpenSearch?** It's a copy that can lag. Money paths read the truth.
7. **What is CQRS, in one sentence?** Different models for writing and reading, each shaped for its job, connected by
   events.
8. **How would this scale?** More OpenSearch nodes and shards, replicas for reads and availability; the indexer scales
   by more consumers on the queue.

---

## 8. Self-quiz

1. Why did adding a fallback make the overload worse at 200 searches/s?
2. What does the bulkhead do, and why 503 instead of waiting?
3. Why does the indexer read MySQL instead of trusting the event?
4. How do you rebuild the index with no downtime?
5. Why did "sneaker" match "sweater", and what fixed it?
6. Why do facets have their own circuit breaker?
7. How did a stopped OpenSearch break the cart?

<details><summary>Answers</summary>

1. The breaker moved every search from the overloaded OpenSearch to MySQL, which is slower at search: MySQL hit
   165–185% CPU and slowed the cart too (cascading failure).
2. It caps fallback searches at 4 at once; a quick 503 sheds load instead of queueing it on MySQL. MySQL stayed at 55%.
3. Events can repeat or arrive out of order; reading the current row makes every apply give the latest truth
   (idempotent).
4. Build a new index, copy in batches, switch the alias atomically, copy what changed meanwhile, delete the old one.
5. Default fuzziness allows 2 edits from 6 letters ("sneaker" → "sweater" is 2 edits). `AUTO:3,8` allows 2 only from
   8 letters: back to 8,004 matches, 20/20 found.
6. Slow aggregations used to open the shared breaker and send plain searches to MySQL as well.
7. Every search started a DNS lookup of the dead name (4 s each in Docker) on Node's 4-thread pool; the cart's new
   MySQL connections waited behind them and timed out. Shared lookups fixed it (0 failures).

</details>
