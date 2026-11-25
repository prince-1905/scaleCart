import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProductIndexer } from '../src/catalog/search/product-indexer.js';
import { ProductSearchIndex } from '../src/catalog/search/product-search-index.js';
import { createProduct, dataSource, eventually, http, registerAdmin, startApp, startWorker, type TestUser } from './support.js';

/**
 * Phase 12: product search in OpenSearch (the CQRS read model), kept in sync by product.changed events.
 * Needs OpenSearch on 127.0.0.1:9200 (docker compose up -d opensearch). Index: test-products (fresh every run).
 * Every test uses its own made-up word, so tests and processes sharing the index don't see each other's products.
 */
/** These tests check what search finds, not how fast: a busy OpenSearch during a full parallel run took > 1 s. */
const SLOW_OK = '5000';

describe('product search in OpenSearch (Phase 12)', () => {
  let api: INestApplication;
  let worker: INestApplication;
  let admin: TestUser;
  const word = () => `qx${randomUUID().replaceAll('-', '').slice(0, 10)}`;

  beforeAll(async () => {
    worker = await startWorker();
    await worker.get(ProductSearchIndex).ensureIndex();
    api = await startApp('fastify', { SEARCH_ENGINE: 'opensearch', LAB_ENDPOINTS: 'true', SEARCH_TIMEOUT_MS: SLOW_OK });
    admin = await registerAdmin(api);
  });
  afterAll(async () => {
    await api.close();
    await worker.close();
  });

  const search = (q: string, extra = '') => http(api).get(`/products/search?q=${encodeURIComponent(q)}${extra}`);
  const found = async (q: string, extra = '') => ((await search(q, extra)).body as { id: number }[]).map((p) => p.id);

  it('a new product becomes searchable through the outbox → RabbitMQ → indexer, with typos forgiven', async () => {
    const w = word();
    const id = await createProduct(api, admin, { name: `Sneaker ${w}`, category: 'footwear' });
    await eventually(async () => (await found(w)).includes(id));
    const res = await search(`snaeker ${w}`); // a typo in the first word
    expect(res.headers['x-search-source']).toBe('opensearch');
    expect(res.body.map((p: { id: number }) => p.id)).toContain(id);
    // A typo in the LAST word: the prefix query alone forgives none there (found while building this, E15).
    expect(await found(`${w} snaeker`)).toContain(id);
    // …and an unfinished last word still works.
    expect(await found(`${w} snea`)).toContain(id);
  });

  it('an edit reaches the search copy: the new name is found, the old one is not', async () => {
    const oldWord = word();
    const newWord = word();
    const id = await createProduct(api, admin, { name: `Jacket ${oldWord}`, category: 'fashion' });
    await eventually(async () => (await found(oldWord)).includes(id));
    await http(api).patch(`/products/${id}`).auth(admin.accessToken, { type: 'bearer' }).send({ name: `Jacket ${newWord}` }).expect(200);
    await eventually(async () => (await found(newWord)).includes(id));
    expect(await found(oldWord)).not.toContain(id);
  });

  it('shoppers only see listed (categorised) products; scope=all is lab-only', async () => {
    const w = word();
    const id = await createProduct(api, admin, { name: `Draft ${w}` }); // no category = not listed
    await eventually(async () => (await found(w, '&scope=all')).includes(id));
    expect(await found(w)).not.toContain(id);
    const shop = await startApp('fastify', { SEARCH_ENGINE: 'opensearch', SEARCH_TIMEOUT_MS: SLOW_OK }); // LAB_ENDPOINTS off
    try {
      await http(shop).get(`/products/search?q=${w}&scope=all`).expect(400);
    } finally {
      await shop.close();
    }
  });

  it('facets: counts per category and price range for the same search, in one answer', async () => {
    const w = word();
    await createProduct(api, admin, { name: `Boot ${w}`, category: 'footwear', priceCents: 900 });
    await createProduct(api, admin, { name: `Boot ${w} two`, category: 'footwear', priceCents: 4_000 });
    const bag = await createProduct(api, admin, { name: `Bag ${w}`, category: 'fashion', priceCents: 12_000 });
    await eventually(async () => (await found(w)).includes(bag));
    await eventually(async () => (await found(w)).length === 3);
    const facets = (await http(api).get(`/products/search/facets?q=${w}`).expect(200)).body;
    expect(facets).toMatchObject({ total: 3, source: 'opensearch' });
    expect(facets.categories).toEqual(expect.arrayContaining([{ category: 'footwear', count: 2 }, { category: 'fashion', count: 1 }]));
    const ranges = Object.fromEntries(facets.priceRanges.map((r: { key: string; count: number }) => [r.key, r.count]));
    expect(ranges).toMatchObject({ 'under-10': 1, '25-50': 1, '100-plus': 1, '10-25': 0, '50-100': 0 });
  });

  it('the indexer is idempotent and follows MySQL: a repeat changes nothing, a vanished product is removed', async () => {
    const w = word();
    const id = await createProduct(api, admin, { name: `Glove ${w}`, category: 'fashion' });
    await eventually(async () => (await found(w)).includes(id));
    const indexer = worker.get(ProductIndexer);
    expect(await indexer.apply(id)).toBe('indexed'); // the same event again: same document
    expect(await found(w)).toEqual([id]);
    // Gone from MySQL (the truth) → the next event for it removes the copy.
    await dataSource(api, 'catalog').query('DELETE FROM products WHERE id = ?', [id]);
    expect(await indexer.apply(id)).toBe('removed');
    await eventually(async () => !(await found(w)).includes(id));
  });

  it('OpenSearch unreachable → search still answers, from MySQL (marked mysql-fallback)', async () => {
    const w = word();
    const id = await createProduct(api, admin, { name: `Scarf ${w}`, category: 'fashion' });
    const blind = await startApp('fastify', { SEARCH_ENGINE: 'opensearch', OPENSEARCH_URL: 'http://127.0.0.1:9299', SEARCH_TIMEOUT_MS: '300' });
    try {
      const res = await http(blind).get(`/products/search?q=${w}`).expect(200);
      expect(res.headers['x-search-source']).toBe('mysql-fallback');
      expect(res.body.map((p: { id: number }) => p.id)).toContain(id);
      const facets = (await http(blind).get(`/products/search/facets?q=${w}`).expect(200)).body;
      expect(facets).toMatchObject({ total: 1, source: 'mysql-fallback' });
    } finally {
      await blind.close();
    }
  });

  it('SEARCH_ENGINE=mysql uses MySQL FULLTEXT on purpose (no typo tolerance there)', async () => {
    const w = word();
    const id = await createProduct(api, admin, { name: `Sandal ${w}`, category: 'footwear' });
    const mysql = await startApp('fastify', { SEARCH_ENGINE: 'mysql' });
    try {
      const res = await http(mysql).get(`/products/search?q=sandal ${w}`).expect(200);
      expect(res.headers['x-search-source']).toBe('mysql');
      expect(res.body.map((p: { id: number }) => p.id)).toContain(id);
      const typo = await http(mysql).get(`/products/search?q=sandle ${w}`).expect(200);
      expect(typo.body.map((p: { id: number }) => p.id)).not.toContain(id);
    } finally {
      await mysql.close();
    }
  });
});
