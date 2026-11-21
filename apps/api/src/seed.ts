/**
 * Fills the shop's databases with demo and load-test products. Safe to run repeatedly.
 *
 *   node dist/seed.js                       1,000 products
 *   SEED_PRODUCTS=200000 node dist/seed.js
 *
 * Users (the admin and loadtest+<n>@scalecart.local) are seeded by the identity service since Phase 11:
 * docker compose run --rm identity-migrate node dist/seed.js
 */
import { DataSource } from 'typeorm';
import { catalogDatabase } from './catalog/catalog.database.js';
import { loadDbConfig } from './config/env.js';
import { mysqlOptions, type ModuleDatabase } from './database/database.js';
import { inventoryDatabase } from './inventory/inventory.database.js';

const env = process.env;
const PRODUCTS = Number(env.SEED_PRODUCTS ?? 1000);
const STOCK = Number(env.SEED_STOCK ?? 100);
const BATCH = 1000;

const ADJECTIVES = ['classic', 'modern', 'rugged', 'slim', 'cozy', 'vintage', 'premium', 'light', 'heavy', 'soft', 'sporty', 'elegant', 'compact', 'urban', 'outdoor', 'travel', 'everyday', 'limited', 'retro', 'pro'];
const COLORS = ['black', 'white', 'red', 'blue', 'green', 'grey', 'navy', 'olive', 'sand', 'brown', 'pink', 'yellow', 'orange', 'purple', 'teal'];
const MATERIALS = ['cotton', 'wool', 'leather', 'denim', 'linen', 'canvas', 'suede', 'nylon', 'cashmere', 'fleece', 'silk', 'bamboo'];
const NOUNS = ['sneaker', 'boot', 'jacket', 'hoodie', 'shirt', 'backpack', 'cap', 'scarf', 'sweater', 'jeans', 'sandal', 'coat', 'wallet', 'belt', 'beanie', 'glove', 'tote', 'vest', 'parka', 'loafer', 'shorts', 'blazer', 'duffel', 'watch', 'sunglasses'];

const pick = <T>(list: T[], n: number) => list[n % list.length];

function product(i: number) {
  const adj = pick(ADJECTIVES, i);
  const color = pick(COLORS, Math.floor(i / 7));
  const material = pick(MATERIALS, Math.floor(i / 11));
  const noun = pick(NOUNS, Math.floor(i / 3));
  const sku = `SEED-${String(i).padStart(7, '0')}`;
  return {
    sku,
    name: `${adj} ${color} ${material} ${noun}`,
    description: `A ${adj} ${noun} in ${color}, made of ${material}. Model ${sku}.`,
    priceCents: 500 + ((i * 7919) % 20_000),
  };
}

async function open(def: ModuleDatabase) {
  const ds = new DataSource(mysqlOptions(loadDbConfig(), def, 2));
  return ds.initialize();
}

const placeholders = (rows: number, cols: number) =>
  Array.from({ length: rows }, () => `(${Array(cols).fill('?').join(', ')})`).join(', ');

async function seedProducts(catalog: DataSource, inventory: DataSource) {
  for (let start = 1; start <= PRODUCTS; start += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, PRODUCTS - start + 1) }, (_, k) => product(start + k));
    await catalog.query(
      `INSERT IGNORE INTO products (sku, name, description, price_cents) VALUES ${placeholders(rows.length, 4)}`,
      rows.flatMap((p) => [p.sku, p.name, p.description, p.priceCents]),
    );
    const ids: { id: number }[] = await catalog.query('SELECT id FROM products WHERE sku IN (?)', [
      rows.map((p) => p.sku),
    ]);
    // INSERT IGNORE: re-seeding never resets stock that load tests already used up.
    await inventory.query(
      `INSERT IGNORE INTO stock (product_id, available) VALUES ${placeholders(ids.length, 2)}`,
      ids.flatMap(({ id }) => [id, STOCK]),
    );
    if ((start - 1) % 20_000 === 0) console.log(`products: ${start - 1} / ${PRODUCTS}`);
  }
  console.log(`products: ${PRODUCTS} seeded (stock ${STOCK} each where new)`);
}

const [catalog, inventory] = await Promise.all([catalogDatabase, inventoryDatabase].map(open));
try {
  await seedProducts(catalog, inventory);
} finally {
  await Promise.all([catalog, inventory].map((ds) => ds.destroy()));
}
