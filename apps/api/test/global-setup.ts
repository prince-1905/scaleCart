import { createClient } from 'redis';
import { loadDbConfig } from '../src/config/env.js';
import { migrateAll } from '../src/database/migrate.js';
import { TEST_ENV } from './support.js';

/** Fresh state for every run: recreate and migrate the test databases, empty test Redis. */
export default async function setup() {
  await migrateAll(loadDbConfig(TEST_ENV), { recreate: true });

  const redis = createClient({ url: TEST_ENV.REDIS_URL });
  await redis.connect();
  await redis.flushDb();
  await redis.close();
}
