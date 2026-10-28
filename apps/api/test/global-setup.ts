import { loadDbConfig } from '../src/config/env.js';
import { migrateAll } from '../src/database/migrate.js';
import { TEST_ENV } from './support.js';

/** Fresh test databases for every run: drop, recreate, migrate. */
export default async function setup() {
  await migrateAll(loadDbConfig(TEST_ENV), { recreate: true });
}
