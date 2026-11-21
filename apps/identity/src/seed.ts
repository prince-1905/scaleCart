/**
 * Demo and load-test users (moved from the shop's seed in Phase 11). Safe to run repeatedly.
 *
 *   node dist/seed.js                       the admin
 *   SEED_USERS=2000 node dist/seed.js       + loadtest+1..2000@scalecart.local, all with SEED_USER_PASSWORD
 *
 * The admin password comes from ADMIN_PASSWORD (.env). Products are seeded by the shop's seed.
 */
import { DataSource } from 'typeorm';
import { uuidv7 } from './common/uuid.js';
import { loadDbConfig } from './config/env.js';
import { mysqlOptions, retry } from './database/database.js';
import { PasswordHasher } from './identity/password-hasher.js';

const env = process.env;
const USERS = Number(env.SEED_USERS ?? 0);
// Fake shoppers for load tests only; they exist nowhere but your local database.
const USER_PASSWORD = env.SEED_USER_PASSWORD || 'loadtest-password';
const ADMIN_EMAIL = env.ADMIN_EMAIL || 'admin@scalecart.local';
// No default: an admin account with a published password would be an open door.
const ADMIN_PASSWORD = env.ADMIN_PASSWORD ?? '';
if (ADMIN_PASSWORD.length < 10) throw new Error('Set ADMIN_PASSWORD (10+ characters) in .env before seeding');
const BATCH = 1000;
const placeholders = (rows: number, cols: number) =>
  Array.from({ length: rows }, () => `(${Array.from({ length: cols }, () => '?').join(', ')})`).join(', ');

const db = new DataSource(mysqlOptions(loadDbConfig(), 2));
await retry(() => db.initialize(), 30, 2_000);
try {
  const hasher = new PasswordHasher();
  await db.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'admin') AS new
       ON DUPLICATE KEY UPDATE password_hash = new.password_hash, role = 'admin'`,
    [uuidv7(), ADMIN_EMAIL, await hasher.hash(ADMIN_PASSWORD)],
  );
  console.log(`admin: ${ADMIN_EMAIL}`);

  if (USERS > 0) {
    // One hash for every load-test user: hashing 2,000 passwords would take minutes.
    const hash = await hasher.hash(USER_PASSWORD);
    for (let start = 1; start <= USERS; start += BATCH) {
      const n = Math.min(BATCH, USERS - start + 1);
      const rows = Array.from({ length: n }, (_, k) => [uuidv7(), `loadtest+${start + k}@scalecart.local`, hash]);
      await db.query(`INSERT IGNORE INTO users (id, email, password_hash) VALUES ${placeholders(n, 3)}`, rows.flat());
    }
    console.log(`load-test users: loadtest+1..${USERS}@scalecart.local`);
  }
} finally {
  await db.destroy();
}
