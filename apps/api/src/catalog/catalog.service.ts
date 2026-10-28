import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CacheService } from '../cache/cache.service.js';
import { ENV, type Env } from '../config/env.js';
import { isDuplicateKey } from '../database/database.js';
import type { CreateProductDto, ListProductsQuery, UpdateProductDto } from './catalog.dto.js';
import { Product } from './product.entity.js';
import { toBooleanQuery } from './search-query.js';

export interface ProductView {
  id: number;
  sku: string;
  name: string;
  description: string;
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
  priceCents: p.priceCents,
});

/** Bump when ProductView's shape changes, so old cached JSON is simply never read again. */
const productKey = (id: number) => `catalog:product:v1:${id}`;

/** The catalog module's public API. Other modules use this, never the products table. */
@Injectable()
export class CatalogService {
  private readonly ttl: number;

  constructor(
    @InjectRepository(Product, 'catalog') private readonly products: Repository<Product>,
    private readonly cache: CacheService,
    @Inject(ENV) env: Env,
  ) {
    this.ttl = env.cacheTtlSeconds;
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
      const result = await this.products.insert({
        sku: dto.sku,
        name: dto.name,
        description: dto.description,
        priceCents: dto.priceCents,
      });
      const id: number = result.identifiers[0].id;
      return { id, sku: dto.sku, name: dto.name, description: dto.description, priceCents: dto.priceCents };
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictException(`sku ${dto.sku} already exists`);
      throw err;
    }
  }

  /** Write to MySQL first, then drop the cached copy so the next read loads the new row. */
  async update(id: number, dto: UpdateProductDto): Promise<ProductView> {
    const result = await this.products.update({ id }, dto);
    if (!result.affected) throw new NotFoundException('product not found');
    await this.cache.invalidate(productKey(id));
    return (await this.getById(id))!;
  }
}
