import { Inject, Injectable, Logger } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import http from 'node:http';
import { sharedLookup } from '../../common/shared-lookup.js';
import { ENV, type Env } from '../../config/env.js';
import type { SearchProductsQuery } from '../catalog.dto.js';
import type { ProductView } from '../catalog.service.js';

/**
 * Product search in OpenSearch (Phase 12): the read side of CQRS. MySQL (catalog) is the truth; this index is a copy
 * shaped for searching, kept up to date by product.changed events (ProductIndexer) and rebuildable from MySQL at any
 * time (dist/reindex.js). Money paths never read it: prices for orders always come from MySQL.
 */

/** One product as stored in the index: what search results show, plus `listed` (categorised = visible to shoppers). */
export interface ProductDocument extends ProductView {
  listed: boolean;
}

export const toDocument = (p: ProductView): ProductDocument => ({ ...p, listed: p.category !== null });

/**
 * The mapping: how each field is indexed.
 *   name, description   full text, English analyzer (stemming: "sneakers" finds "sneaker"); name counts ×3 at query time
 *   category, sku       exact values (filters, facets)
 *   priceCents, id      numbers (ranges, sorting)
 */
export const PRODUCT_MAPPING = {
  settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '1s' },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: { type: 'integer' },
      sku: { type: 'keyword' },
      name: { type: 'text', analyzer: 'english' },
      description: { type: 'text', analyzer: 'english' },
      category: { type: 'keyword' },
      priceCents: { type: 'integer' },
      listed: { type: 'boolean' },
    },
  },
} as const;

/** Price buckets for the facet counts, in cents. */
export const PRICE_RANGES = [
  { key: 'under-10', to: 1_000 },
  { key: '10-25', from: 1_000, to: 2_500 },
  { key: '25-50', from: 2_500, to: 5_000 },
  { key: '50-100', from: 5_000, to: 10_000 },
  { key: '100-plus', from: 10_000 },
] as const;

export interface SearchFacets {
  total: number;
  categories: { category: string; count: number }[];
  priceRanges: { key: string; count: number }[];
}

/** Lab experiments search all 200k products; shoppers only the listed (categorised) ones. */
export type SearchScope = 'listed' | 'all';

@Injectable()
export class ProductSearchIndex {
  private readonly logger = new Logger(ProductSearchIndex.name);
  readonly client: Client;
  /** The alias every search and every write goes to. The real index behind it is `<alias>_<timestamp>`. */
  readonly alias: string;

  private readonly facetsTimeoutMs: number;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Client({
      node: env.openSearchUrl,
      requestTimeout: env.searchTimeoutMs,
      maxRetries: 0,
      // The client's usual agent settings, plus a shared DNS lookup (see sharedLookup: a stopped OpenSearch used to
      // block the lookups MySQL connections need, and the cart failed).
      agent: () =>
        new http.Agent({
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 256,
          maxFreeSockets: 256,
          scheduling: 'lifo',
          lookup: sharedLookup() as never,
        }),
    });
    this.alias = env.searchIndex;
    this.facetsTimeoutMs = env.searchTimeoutMs * 3;
  }

  /**
   * Creates the first index behind the alias if there is none yet (later ones come from a re-index). A fixed name
   * (<alias>_1): when several workers start at once, only one create succeeds and the alias points at ONE index.
   * With timestamped names each would add its own and writes to the alias would fail ("no write index").
   */
  async ensureIndex(): Promise<void> {
    // An admin operation, not a shopper's search: creating an index on a busy node can take seconds, more than the
    // 1 s search timeout (the e2e setup timed out on it under load).
    const admin = { requestTimeout: 30_000 };
    const exists = await this.client.indices.existsAlias({ name: this.alias }, admin);
    if (exists.body) return;
    const index = `${this.alias}_1`;
    try {
      await this.client.indices.create({ index, body: { ...PRODUCT_MAPPING, aliases: { [this.alias]: {} } } }, admin);
      this.logger.log(`created search index ${index} (alias ${this.alias})`);
    } catch (err) {
      const type = (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
      if (type !== 'resource_already_exists_exception') throw err; // another worker was first: fine
    }
  }

  /**
   * Write one product's latest state (or remove it when it no longer exists in MySQL).
   *
   * `require_alias`: write only through the alias. Without it, a write that came before the alias existed (OpenSearch
   * slow at the worker's start) made OpenSearch auto-create a plain INDEX named like the alias, and from then on the
   * alias, and so the zero-downtime re-index, could never be created (found in Phase 13's test runs). Now such a
   * write fails, the alias is created properly, and the write is retried.
   */
  async put(doc: ProductDocument): Promise<void> {
    const write = () => this.client.index({ index: this.alias, id: String(doc.id), body: doc, require_alias: true });
    try {
      await write();
    } catch (err) {
      const type = (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
      if (type !== 'index_not_found_exception') throw err;
      await this.ensureIndex();
      await write();
    }
  }

  async remove(id: number): Promise<void> {
    await this.client.delete({ index: this.alias, id: String(id) }).catch((err: { meta?: { statusCode?: number } }) => {
      if (err.meta?.statusCode !== 404) throw err; // already gone: fine
    });
  }

  /** Many documents in one request (re-index). `index` defaults to the alias. */
  async bulkPut(docs: ProductDocument[], index: string = this.alias): Promise<void> {
    if (docs.length === 0) return;
    const body = docs.flatMap((d) => [{ index: { _index: index, _id: String(d.id) } }, d]);
    const res = await this.client.bulk({ body });
    if (res.body.errors) {
      const first = res.body.items.find((i: { index?: { error?: unknown } }) => i.index?.error);
      throw new Error(`bulk indexing failed: ${JSON.stringify(first?.index?.error).slice(0, 200)}`);
    }
  }

  async search(query: SearchProductsQuery, scope: SearchScope = 'listed'): Promise<ProductView[]> {
    const res = await this.client.search({
      index: this.alias,
      body: {
        size: query.limit,
        track_total_hits: false,
        query: this.query(query, scope),
        sort: sortFor(query, !!query.q?.trim()),
      },
    });
    return res.body.hits.hits.map((h) => {
      const { listed: _listed, ...view } = h._source as ProductDocument;
      return view;
    });
  }

  /** Counts per category and price range for the same search, in one request (aggregations). */
  async facets(query: SearchProductsQuery, scope: SearchScope = 'listed'): Promise<SearchFacets> {
    const body = {
      size: 0,
      track_total_hits: true,
      query: this.query(query, scope),
      aggs: {
        categories: { terms: { field: 'category', size: 50 } },
        prices: { range: { field: 'priceCents', ranges: PRICE_RANGES.map((r) => ({ ...r })) } },
      },
    };
    // The client's TypeScript types don't list `field` for a terms aggregation (the server accepts it): pass as is.
    // Aggregations over many matches cost more than a page of hits: a longer timeout than plain search (E15c).
    const res = await this.client.search({ index: this.alias, body: body as never }, { requestTimeout: this.facetsTimeoutMs });
    const aggs = res.body.aggregations as {
      categories: { buckets: { key: string; doc_count: number }[] };
      prices: { buckets: { key: string; doc_count: number }[] };
    };
    return {
      total: (res.body.hits.total as { value: number }).value,
      categories: aggs.categories.buckets.map((b) => ({ category: b.key, count: b.doc_count })),
      priceRanges: aggs.prices.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
    };
  }

  /**
   * Every word must match (like the MySQL search), but:
   *   - each word may be misspelled (fuzziness AUTO: 1 edit for 3–5 letters, 2 for longer: "sneeker" → "sneaker")
   *   - the last word may be unfinished ("bool_prefix": "black sne" finds "black sneaker")
   *   - a match in the name counts 3× a match in the description
   */
  private query(query: SearchProductsQuery, scope: SearchScope) {
    const filter: object[] = [];
    if (scope === 'listed') filter.push({ term: { listed: true } });
    if (query.category) filter.push({ term: { category: query.category } });
    if (query.minPriceCents !== undefined || query.maxPriceCents !== undefined) {
      filter.push({ range: { priceCents: { gte: query.minPriceCents, lte: query.maxPriceCents } } });
    }
    const q = query.q?.trim().slice(0, 100);
    // Two ways to match, either is enough:
    //   typos:    every word, each allowed a typo ("sneeker" → sneaker, "black lether" → black leather)
    //   prefix:   the same, but the LAST word may be unfinished ("black sne" → black sneaker). OpenSearch applies
    //             no typo tolerance to that prefix word, which is why the first query alone is needed (E15: found
    //             while testing, a one-word typo matched nothing with the prefix query alone).
    const fields = ['name^3', 'description'];
    // Cheaper typo matching (E15b: at 200 searches/s OpenSearch's one core was full): the first letter must be right
    // and each word expands to at most 20 similar terms. Trade-off: a typo in the FIRST letter is not forgiven.
    // AUTO:3,8 = 1 typo from 3 letters, 2 only from 8. With plain AUTO (2 from 6) "sneaker" also matched "sweater"
    // (2 letters apart) and the result count doubled; with AUTO:4,8 "woo swea" no longer found wool (E15c).
    // Swapped letters ("snekaer") count as one typo.
    const fuzzy = { fuzziness: 'AUTO:3,8', prefix_length: 1, max_expansions: 20 };
    const must = q
      ? [
          {
            bool: {
              should: [
                { multi_match: { query: q, fields, ...fuzzy, operator: 'and' as const } },
                { multi_match: { query: q, type: 'bool_prefix' as const, fields, ...fuzzy, operator: 'and' as const } },
              ],
              minimum_should_match: 1,
            },
          },
        ]
      : [{ match_all: {} }];
    return { bool: { must, filter } };
  }
}

type SortClause = '_score' | Record<string, 'asc' | 'desc'>;

function sortFor(query: SearchProductsQuery, hasText: boolean): SortClause[] {
  if (query.sort === 'price_asc') return [{ priceCents: 'asc' }, { id: 'asc' }];
  if (query.sort === 'price_desc') return [{ priceCents: 'desc' }, { id: 'asc' }];
  if (query.sort === 'newest') return [{ id: 'desc' }];
  return hasText ? ['_score', { id: 'asc' }] : [{ id: 'asc' }];
}
