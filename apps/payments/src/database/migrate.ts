import { DataSource } from 'typeorm';
import { loadDbConfig } from '../config/env.js';
import { mysqlOptions, retry } from './database.js';

/**
 * Applies this service's migrations to its own database, once, before the service starts (a Compose job).
 * The database and the login are created by MySQL's init scripts; this service can't create databases.
 */
const db = loadDbConfig();
const ds = new DataSource(mysqlOptions(db, 1));
await retry(() => ds.initialize(), 30, 2_000);
try {
  const applied = await ds.runMigrations();
  console.log(`${db.database}: ${applied.length} migration(s) applied`);
} finally {
  await ds.destroy();
}
