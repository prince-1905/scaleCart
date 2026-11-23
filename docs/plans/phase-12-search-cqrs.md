# Plan — Phase 12: product search in OpenSearch, kept in sync by events (CQRS)

Decided with the owner (2026-11-21): **OpenSearch** (`opensearchproject/opensearch:3.8.0`, one node, security plugin
off on the Docker network) and the official Node client `@opensearch-project/opensearch` 3.9.0. Branch
`phase-12-search` from `main` after PR #18 (identity) is merged.

## Today

`GET /products/search` runs on MySQL: a FULLTEXT index on name + description, boolean mode, optional category and price
filters, sorted by relevance or price, cached in Redis for public reads. Weak spots to measure:

1. **No typo tolerance:** "sneeker" or "jaket" find nothing.
2. **Crude ranking:** word matches, no field weights ("Black sneaker" in the name should beat a description mention).
3. **Facets are expensive:** "how many results per category / price range" needs extra GROUP BY queries over 200k rows.
4. **Search load lands on the MySQL that checkout needs** during a drop.

## CQRS: one write model, one read model

```
 write side (truth)                                   read side (built for searching)
 admin creates/edits a product ─► MySQL catalog ─► outbox event product.changed ─► RabbitMQ ─► indexer (worker)
 stock changes ──────────────────► MySQL inventory ─► (later: in-stock flag)                      │
                                                                                                  ▼
 GET /products/search ─────────────────────────────────────────────────────────────────► OpenSearch "products"
                       (falls back to MySQL FULLTEXT if OpenSearch is down: slower, no typo tolerance, still works)
 GET /products/:id, checkout, prices for orders ─► MySQL only (money paths never trust the copy)
```

- **The copy lags a little** (outbox poll + queue + indexing): we measure how much ("eventual consistency").
- **Rebuildable:** a full re-index job reads MySQL in keyset batches into a NEW index, then switches an alias
  (`products` → `products_v2`): zero-downtime re-index, the classic way to change mappings.
- **Mapping:** name (boosted ×3) and description as text with an English analyzer; category keyword; price integer;
  fuzzy matching (`fuzziness: AUTO`) for typos; aggregations for category facets and price ranges.

## Steps

| Step | What |
|---|---|
| 12a | Compose service `opensearch` (single node, 512 MB heap, security off on the internal network), healthcheck, Prometheus-friendly stats later |
| 12b | `SearchIndex` in the catalog module: index mapping, `index/delete`, `search` (multi_match + fuzziness + filters + sort + facets) |
| 12c | Events: `product.changed` / `product.deleted` written to the catalog outbox (same transaction as the product write); indexer consumer in the worker (idempotent: index by id, version check) |
| 12d | Full re-index job (`dist/reindex.js`): keyset batches → new index → alias switch |
| 12e | `/products/search` reads OpenSearch, with the MySQL FULLTEXT fallback (circuit breaker) and a `SEARCH_ENGINE=mysql|opensearch` switch for experiments; facets in the response |
| 12f | Tests (fake vs real OpenSearch in e2e), E15, docs |

## E15 — what we will measure

1. **Quality:** a fixed list of queries with typos and partial words: found / not found, top-3 relevance, MySQL vs
   OpenSearch.
2. **Speed under load:** the same search mix (k6) on MySQL FULLTEXT vs OpenSearch, uncached: p50/p95, MySQL CPU, and
   what it does to checkout latency at the same time.
3. **Facets:** category + price-range counts: one OpenSearch query vs MySQL GROUP BYs.
4. **Freshness:** a product edited → how long until search shows it (outbox + queue + indexing); during a burst of edits.
5. **OpenSearch down:** search falls back to MySQL, nothing else breaks; then catches up when it's back.
6. **Re-index:** 200k products into a new index while searches run: time, errors (alias switch = 0 downtime?).
