import { createClient } from 'redis';
import { loadDbConfig } from '../src/config/env.js';
import { migrateAll } from '../src/database/migrate.js';
import { TEST_ENV } from './support.js';

/** Fresh state for every run: recreate and migrate the test databases, empty test Redis. */
export default async function setup() {
  await migrateAll(loadDbConfig(TEST_ENV), { recreate: true });

  // Phase 12: drop the test search indexes (test-products_<n>); the worker in search.e2e creates a fresh one. Also a
  // plain "test-products" index, which the old put() (before require_alias, Phase 13) could auto-create.
  const os = TEST_ENV.OPENSEARCH_URL!;
  const indexes = await fetch(`${os}/_cat/indices/${TEST_ENV.SEARCH_INDEX}*?format=json`)
    .then((r) => (r.ok ? (r.json() as Promise<{ index: string }[]>) : []))
    .catch(() => []);
  for (const { index } of indexes) await fetch(`${os}/${index}`, { method: 'DELETE' });

  const redis = createClient({ url: TEST_ENV.REDIS_URL });
  await redis.connect();
  await redis.flushDb();
  await redis.close();
}
