import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type EntityManager } from 'typeorm';
import { CacheService } from '../cache/cache.service.js';
import { ENV, type Env } from '../config/env.js';
import { currentTraceparent } from '../common/trace-context.js';
import { uuidv7 } from '../common/uuid.js';
import { isDuplicateKey } from '../database/database.js';
import { PRODUCT_CHANGED, type ProductChangedEvent } from './events.js';
import type {
  CreateProductDto,
  ListProductsQuery,
  SearchProductsQuery,
  UpdateProductDto,
} from './catalog.dto.js';
import { Product } from './product.entity.js';
import { toBooleanQuery } from './search-query.js';
import { CircuitBreaker, CircuitOpenError } from '../common/circuit-breaker.js';
import { MetricsService } from '../observability/metrics.service.js';
import { PRICE_RANGES, ProductSearchIndex, type SearchFacets, type SearchScope } from './search/product-search-index.js';

export interface ProductView {
  id: number;
  sku: string;
  name: string;
  description: string;
  category: string | null;
  priceCents: number;
}

export interface ProductPage {
  items: ProductView[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextAfter: number | null;
}

const toView = (p: Product): ProductView => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  description: p.description,
  category: p.category,
  priceCents: p.priceCents,
});

/** Bump when ProductView's shape changes, so old cached JSON is simply never read again. */
const productKey = (id: number) => `catalog:product:v2:${id}`;

const RELEVANCE = 'MATCH (p.name, p.description) AGAINST (:search IN BOOLEAN MODE)';

/** The outbox row that tells the search index "product `id` changed" (read by the worker's relay). */
async function recordChange(m: EntityManager, productId: number) {
  const event: ProductChangedEvent = { productId };
  await m.query('INSERT INTO outbox (id, event_type, aggregate_id, payload, trace_parent) VALUES (?, ?, ?, ?, ?)', [
    uuidv7(),
    PRODUCT_CHANGED,
    String(productId),
    JSON.stringify(event),
    currentTraceparent(),
  ]);
}

/** Which engine answered a search: OpenSearch, MySQL by choice (SEARCH_ENGINE=mysql), or MySQL because OpenSearch failed. */
export type SearchSource = 'opensearch' | 'mysql' | 'mysql-fallback';

/** The catalog module's public API. Other modules use this, never the products table. */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly ttl: number;
  /** OpenSearch failing 5 times in a row → search goes straight to MySQL for 10 s, then tries OpenSearch again. */
  readonly searchBreaker: CircuitBreaker;
  /**
   * Facets have their own breaker (E15c): slow aggregations used to trip the SEARCH breaker and send every plain
   * search to MySQL too.
   */
  readonly facetsBreaker: CircuitBreaker;
  /**
   * Bulkhead on the fallback (E15b): at most this many searches run on MySQL at once when OpenSearch can't answer.
   * Without it, an OpenSearch overload sent ALL search traffic to MySQL and took MySQL (and checkout) down with it.
   * Extra searches get a quick 503 "search_busy" instead.
   */
  private fallbackInFlight = 0;

  constructor(
    @InjectRepository(Product, 'catalog') private readonly products: Repository<Product>,
    private readonly cache: CacheService,
    private readonly searchIndex: ProductSearchIndex,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.ttl = env.cacheTtlSeconds;
    this.searchBreaker = new CircuitBreaker({ failureThreshold: 5, openMs: 10_000 }, (state) => {
      this.logger.warn(`circuit breaker for OpenSearch (search) is now ${state}`);
    });
    this.facetsBreaker = new CircuitBreaker({ failureThreshold: 5, openMs: 10_000 }, (state) => {
      this.logger.warn(`circuit breaker for OpenSearch (facets) is now ${state}`);
    });
  }

  private scopeOf(query: SearchProductsQuery): SearchScope {
    if (query.scope === 'all' && !this.env.labEndpoints) throw new BadRequestException('scope=all is a lab-only option');
    return query.scope ?? 'listed';
  }

  /**
   * Product search (Phase 12): the OpenSearch copy answers (typo-tolerant, ranked); if it can't, MySQL FULLTEXT does
   * (slower, exact words only), so search never goes down with OpenSearch. SEARCH_ENGINE=mysql skips OpenSearch.
   */
  async searchWithSource(query: SearchProductsQuery): Promise<{ items: ProductView[]; source: SearchSource }> {
    const scope = this.scopeOf(query);
    if (this.env.searchEngine === 'opensearch') {
      try {
        const items = await this.searchBreaker.run(() => this.searchIndex.search(query, scope));
        this.metrics.searches.inc({ source: 'opensearch' });
        return { items, source: 'opensearch' };
      } catch (err) {
        if (!(err instanceof CircuitOpenError)) this.logger.warn(`OpenSearch search failed, using MySQL: ${(err as Error).message}`);
        const items = await this.onFallback(() => this.mysqlSearch(query, scope));
        this.metrics.searches.inc({ source: 'mysql-fallback' });
        return { items, source: 'mysql-fallback' };
      }
    }
    this.metrics.searches.inc({ source: 'mysql' });
    return { items: await this.mysqlSearch(query, scope), source: 'mysql' };
  }

  /** Runs a MySQL fallback search, unless the bulkhead is full: then a quick 503 instead of piling onto MySQL. */
  private async onFallback<T>(run: () => Promise<T>): Promise<T> {
    if (this.fallbackInFlight >= this.env.searchFallbackConcurrency) {
      this.metrics.searches.inc({ source: 'refused' });
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'search_busy',
        message: 'search is busy right now; try again in a moment',
      });
    }
    this.fallbackInFlight++;
    try {
      return await run();
    } finally {
      this.fallbackInFlight--;
    }
  }

  /** Counts per category and price range for a search (the filter sidebar), from the same engine as the search. */
  async facets(query: SearchProductsQuery): Promise<SearchFacets & { source: SearchSource }> {
    const scope = this.scopeOf(query);
    if (this.env.searchEngine === 'opensearch') {
      try {
        return { ...(await this.facetsBreaker.run(() => this.searchIndex.facets(query, scope))), source: 'opensearch' };
      } catch {
        return { ...(await this.onFallback(() => this.mysqlFacets(query, scope))), source: 'mysql-fallback' };
      }
    }
    return { ...(await this.mysqlFacets(query, scope)), source: 'mysql' };
  }

  /**
   * Product page for shoppers: served from Redis when possible.
   *
   * Only browsing uses the cache. Checkout and the cart read prices with getById/getByIds
   * straight from MySQL: a few seconds of staleness is fine on a product page, never on
   * the amount we charge.
   */
  getPublic(id: number): Promise<ProductView | null> {
    return this.cache.getOrLoad('product', productKey(id), { ttl: this.ttl, missingTtl: 10 }, () =>
      this.getById(id),
    );
  }

  /**
   * Keyset pagination: `WHERE id > :after ORDER BY id LIMIT n` jumps straight to the
   * right spot in the primary-key index, so page 5,000 costs the same as page 1.
   * OFFSET would read and throw away every row before the page (experiment E1).
   *
   * Search results use the same id order, not relevance: ranking, typo tolerance and
   * facets are what a dedicated search engine (OpenSearch) is for.
   */
  async list(query: ListProductsQuery): Promise<ProductPage> {
    const qb = this.products
      .createQueryBuilder('p')
      .orderBy('p.id', 'ASC')
      // One extra row tells us whether another page exists, without a COUNT(*).
      .limit(query.limit + 1);

    if (query.after !== undefined) qb.andWhere('p.id > :after', { after: query.after });

    if (query.q !== undefined) {
      const search = toBooleanQuery(query.q);
      if (!search) return { items: [], nextAfter: null };
      qb.andWhere('MATCH (p.name, p.description) AGAINST (:search IN BOOLEAN MODE)', { search });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toView);
    return { items, nextAfter: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * One page of best matches with filters. Every filter is optional; an empty search
   * returns the cheapest/newest/first products of the category.
   *
   * Only categorised products are listed for shoppers: uncategorised ones (the 200k
   * load-test rows) are "not listed yet", like a draft product in a real shop.
   */
  async search(query: SearchProductsQuery): Promise<ProductView[]> {
    return (await this.searchWithSource(query)).items;
  }

  /** The same search with MySQL FULLTEXT (before Phase 12, and the fallback): every word required, prefixes allowed. */
  private async mysqlSearch(query: SearchProductsQuery, scope: SearchScope): Promise<ProductView[]> {
    const qb = this.mysqlFiltered(query, scope);
    if (!qb) return [];
    qb.limit(query.limit);
    const search = query.q?.trim() ? toBooleanQuery(query.q) : null;

    if (query.sort === 'price_asc') qb.orderBy('p.priceCents', 'ASC');
    else if (query.sort === 'price_desc') qb.orderBy('p.priceCents', 'DESC');
    else if (query.sort === 'newest') qb.orderBy('p.id', 'DESC');
    else if (search) qb.addSelect(RELEVANCE, 'score').orderBy('score', 'DESC');
    qb.addOrderBy('p.id', 'ASC');

    return (await qb.getMany()).map(toView);
  }

  /** The WHERE part shared by search and facets; null when the text has nothing searchable (no results). */
  private mysqlFiltered(query: SearchProductsQuery, scope: SearchScope) {
    const qb = this.products.createQueryBuilder('p');
    if (scope === 'listed') qb.where('p.category IS NOT NULL');
    if (query.q?.trim()) {
      const search = toBooleanQuery(query.q);
      if (!search) return null;
      qb.andWhere(RELEVANCE, { search });
    }
    if (query.category) qb.andWhere('p.category = :category', { category: query.category });
    if (query.minPriceCents !== undefined) qb.andWhere('p.priceCents >= :min', { min: query.minPriceCents });
    if (query.maxPriceCents !== undefined) qb.andWhere('p.priceCents <= :max', { max: query.maxPriceCents });
    return qb;
  }

  /** Facets on MySQL: one GROUP BY for the categories, one pass of conditional sums for the price ranges. */
  private async mysqlFacets(query: SearchProductsQuery, scope: SearchScope): Promise<SearchFacets> {
    const base = this.mysqlFiltered(query, scope);
    if (!base) return { total: 0, categories: [], priceRanges: PRICE_RANGES.map((r) => ({ key: r.key, count: 0 })) };
    const categories: { category: string; count: string }[] = await base
      .clone()
      .select('p.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .andWhere('p.category IS NOT NULL')
      .groupBy('p.category')
      .orderBy('count', 'DESC')
      .getRawMany();
    const sums = PRICE_RANGES.map((r, i) => {
      const from = 'from' in r ? `p.priceCents >= ${r.from}` : '';
      const to = 'to' in r ? `p.priceCents < ${r.to}` : '';
      return `SUM(${[from, to].filter(Boolean).join(' AND ')}) AS r${i}`;
    });
    const row = await base.clone().select('COUNT(*)', 'total').addSelect(sums.join(', ')).getRawOne();
    return {
      total: Number(row?.total ?? 0),
      categories: categories.map((c) => ({ category: c.category, count: Number(c.count) })),
      priceRanges: PRICE_RANGES.map((r, i) => ({ key: r.key, count: Number(row?.[`r${i}`] ?? 0) })),
    };
  }

  async getById(id: number): Promise<ProductView | null> {
    const product = await this.products.findOneBy({ id });
    return product ? toView(product) : null;
  }

  async getByIds(ids: number[]): Promise<Map<number, ProductView>> {
    if (ids.length === 0) return new Map();
    const rows = await this.products.findBy({ id: In(ids) });
    return new Map(rows.map((p) => [p.id, toView(p)]));
  }

  async create(dto: CreateProductDto): Promise<ProductView> {
    try {
      // The product and its "product.changed" event in ONE transaction (outbox): the search copy can't miss it.
      const id = await this.products.manager.transaction(async (m) => {
        const result = await m.insert(Product, {
          sku: dto.sku,
          name: dto.name,
          description: dto.description,
          category: dto.category ?? null,
          priceCents: dto.priceCents,
        });
        const newId: number = result.identifiers[0].id;
        await recordChange(m, newId);
        return newId;
      });
      return {
        id,
        sku: dto.sku,
        name: dto.name,
        description: dto.description,
        category: dto.category ?? null,
        priceCents: dto.priceCents,
      };
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictException(`sku ${dto.sku} already exists`);
      throw err;
    }
  }

  /**
   * Write to MySQL first (with the product.changed event, same transaction), then drop the cached copy so the next
   * read loads the new row. The search copy follows a moment later (outbox → RabbitMQ → indexer).
   */
  async update(id: number, dto: UpdateProductDto): Promise<ProductView> {
    const affected = await this.products.manager.transaction(async (m) => {
      const result = await m.update(Product, { id }, dto);
      if (result.affected) await recordChange(m, id);
      return result.affected;
    });
    if (!affected) throw new NotFoundException('product not found');
    await this.cache.invalidate(productKey(id));
    return (await this.getById(id))!;
  }
}
