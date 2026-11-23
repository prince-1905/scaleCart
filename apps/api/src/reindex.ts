/**
 * Rebuilds the product search index from MySQL without downtime (Phase 12):
 *
 *   docker compose run --rm migrate node dist/reindex.js        (or: node dist/reindex.js with the env set)
 *
 * 1. Create a NEW index (products_<timestamp>) with the current mapping.
 * 2. Copy every product from MySQL in keyset batches (id > last, 2,000 at a time) with bulk requests.
 * 3. Switch the alias "products" to the new index in ONE atomic step: searches move over between two requests.
 * 4. Catch up: products changed since step 2 began (updated_at) are copied again, now into the new index. Changes
 *    during the copy also reach the index through product.changed events, so nothing is lost either way.
 * 5. Delete the old index.
 * This is also how a mapping change (a new field, another analyzer) is rolled out.
 */
import { DataSource } from 'typeorm';
import { catalogDatabase } from './catalog/catalog.database.js';
import { Product } from './catalog/product.entity.js';
import { ProductSearchIndex, PRODUCT_MAPPING, toDocument } from './catalog/search/product-search-index.js';
import { loadDbConfig, type Env } from './config/env.js';
import { mysqlOptions } from './database/database.js';

const BATCH = 2_000;
const alias = process.env.SEARCH_INDEX ?? 'products';
const index = new ProductSearchIndex({
  openSearchUrl: (process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:9200').replace(/\/+$/, ''),
  searchIndex: alias,
  searchTimeoutMs: 60_000,
} as Env);

const db = new DataSource(mysqlOptions(loadDbConfig(), catalogDatabase, 2));
await db.initialize();
const started = performance.now();
const ms = () => Math.round(performance.now() - started);

async function copy(target: string, where = '', params: unknown[] = []): Promise<number> {
  let after = 0;
  let copied = 0;
  for (;;) {
    const rows: Product[] = await db
      .getRepository(Product)
      .createQueryBuilder('p')
      .where(`p.id > :after ${where}`, { after, ...Object.fromEntries(params.map((v, i) => [`p${i}`, v])) })
      .orderBy('p.id', 'ASC')
      .limit(BATCH)
      .getMany();
    if (rows.length === 0) return copied;
    await index.bulkPut(
      rows.map((p) => toDocument({ id: p.id, sku: p.sku, name: p.name, description: p.description, category: p.category, priceCents: p.priceCents })),
      target,
    );
    copied += rows.length;
    after = rows[rows.length - 1].id;
    if (copied % 20_000 < BATCH) console.log(`  ${copied} products copied (${ms()} ms)`);
  }
}

try {
  const target = `${alias}_${Date.now()}`;
  const [{ now }] = await db.query('SELECT NOW(3) AS now');
  // Faster bulk loading: no refresh while copying, turned back on before the switch.
  await index.client.indices.create({
    index: target,
    body: { ...PRODUCT_MAPPING, settings: { ...PRODUCT_MAPPING.settings, refresh_interval: '-1' } },
  });
  console.log(`new index ${target}`);
  const copied = await copy(target);
  await index.client.indices.putSettings({ index: target, body: { index: { refresh_interval: '1s' } } });
  await index.client.indices.refresh({ index: target });
  console.log(`copied ${copied} products in ${ms()} ms`);

  const current = await index.client.indices.getAlias({ name: alias }).catch(() => ({ body: {} }));
  const old = Object.keys(current.body ?? {});
  await index.client.indices.updateAliases({
    body: { actions: [...old.map((i) => ({ remove: { index: i, alias } })), { add: { index: target, alias } }] },
  });
  console.log(`alias ${alias}: ${old.join(', ') || '(none)'} → ${target} (${ms()} ms)`);

  const caught = await copy(target, 'AND p.updatedAt >= :p0', [now]);
  console.log(`caught up ${caught} products changed during the copy`);
  for (const i of old) await index.client.indices.delete({ index: i });
  if (old.length) console.log(`deleted old index ${old.join(', ')}`);
  console.log(`done in ${ms()} ms`);
} finally {
  await db.destroy();
}
