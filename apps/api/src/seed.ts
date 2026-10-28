/**
 * Fills the databases with demo and load-test data. Safe to run repeatedly.
 *
 *   node dist/seed.js                                  admin + 1,000 products
 *   SEED_PRODUCTS=200000 SEED_USERS=2000 node dist/seed.js
 *
 * Load-test users are loadtest+<n>@scalecart.local (n = 1..SEED_USERS), all with
 * SEED_USER_PASSWORD, so k6 can log in as thousands of different customers.
 * The admin password comes from ADMIN_PASSWORD (.env).
 */
import { DataSource } from 'typeorm';
import { catalogDatabase } from './catalog/catalog.database.js';
import { uuidv7 } from './common/uuid.js';
import { loadDbConfig } from './config/env.js';
import { mysqlOptions, type ModuleDatabase } from './database/database.js';
import { identityDatabase } from './identity/identity.database.js';
import { PasswordHasher } from './identity/password-hasher.js';
import { inventoryDatabase } from './inventory/inventory.database.js';

const env = process.env;
const PRODUCTS = Number(env.SEED_PRODUCTS ?? 1000);
const STOCK = Number(env.SEED_STOCK ?? 100);
const USERS = Number(env.SEED_USERS ?? 0);
// Fake shoppers for load tests only; they exist nowhere but your local database.
const USER_PASSWORD = env.SEED_USER_PASSWORD || 'loadtest-password';
const ADMIN_EMAIL = env.ADMIN_EMAIL || 'admin@scalecart.local';
// No default: an admin account with a published password would be an open door.
const ADMIN_PASSWORD = env.ADMIN_PASSWORD ?? '';
if (ADMIN_PASSWORD.length < 10) {
  throw new Error('Set ADMIN_PASSWORD (10+ characters) in .env before seeding');
}
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

async function seedUsers(identity: DataSource) {
  const hasher = new PasswordHasher();
  await identity.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'admin') AS new
       ON DUPLICATE KEY UPDATE password_hash = new.password_hash, role = 'admin'`,
    [uuidv7(), ADMIN_EMAIL, await hasher.hash(ADMIN_PASSWORD)],
  );
  console.log(`admin: ${ADMIN_EMAIL}`);

  if (USERS <= 0) return;
  // One hash for every load-test user: hashing 2,000 passwords would take minutes.
  const hash = await hasher.hash(USER_PASSWORD);
  for (let start = 1; start <= USERS; start += BATCH) {
    const n = Math.min(BATCH, USERS - start + 1);
    const rows = Array.from({ length: n }, (_, k) => [uuidv7(), `loadtest+${start + k}@scalecart.local`, hash]);
    await identity.query(
      `INSERT IGNORE INTO users (id, email, password_hash) VALUES ${placeholders(n, 3)}`,
      rows.flat(),
    );
  }
  console.log(`load-test users: loadtest+1..${USERS}@scalecart.local`);
}

const [identity, catalog, inventory] = await Promise.all(
  [identityDatabase, catalogDatabase, inventoryDatabase].map(open),
);
try {
  await seedUsers(identity);
  await seedProducts(catalog, inventory);
} finally {
  await Promise.all([identity, catalog, inventory].map((ds) => ds.destroy()));
}
