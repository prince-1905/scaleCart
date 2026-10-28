import { createConnection } from 'mysql2/promise';
import { DataSource } from 'typeorm';
import type { DbConfig } from '../config/env.js';
import { databaseName, mysqlOptions } from './database.js';
import { MODULE_DATABASES } from './modules.js';

/**
 * Creates each module's database if missing and applies pending migrations.
 *
 * Runs as a one-off job before the API starts (a Compose service now, a Kubernetes
 * Job later), never inside every API replica: four replicas migrating at once race.
 */
export async function migrateAll(
  db: DbConfig,
  options: { recreate?: boolean; log?: (line: string) => void } = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  const admin = await createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
  });
  try {
    for (const def of MODULE_DATABASES) {
      const name = databaseName(db, def.module);
      if (options.recreate) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
    }
  } finally {
    await admin.end();
  }

  for (const def of MODULE_DATABASES) {
    const ds = new DataSource(mysqlOptions(db, def, 1));
    await ds.initialize();
    try {
      const applied = await ds.runMigrations();
      log(`${databaseName(db, def.module)}: ${applied.length} migration(s) applied`);
    } finally {
      await ds.destroy();
    }
  }
}
