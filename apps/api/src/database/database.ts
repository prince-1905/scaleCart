import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSourceOptions, MixedList, EntitySchema } from 'typeorm';
import type { DbConfig } from '../config/env.js';

/**
 * Modular monolith: each module owns one database and nobody else touches it.
 * Splitting a module into its own service later means pointing its DataSource at
 * another server, not untangling joins across modules.
 */
export type ModuleName = 'identity' | 'catalog' | 'inventory' | 'cart' | 'orders';

export interface ModuleDatabase {
  module: ModuleName;
  entities: MixedList<Function | EntitySchema>;
  migrations: Function[];
}

export function databaseName(db: DbConfig, module: ModuleName): string {
  const name = `${db.databasePrefix}${module}`;
  // Database names can't be bound as query parameters, so only allow safe characters.
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return name;
}

export function mysqlOptions(
  db: DbConfig,
  def: ModuleDatabase,
  poolSize: number = db.poolSize,
): DataSourceOptions {
  return {
    type: 'mysql',
    host: db.host,
    port: db.port,
    username: db.user,
    password: db.password,
    database: databaseName(db, def.module),
    entities: def.entities,
    migrations: def.migrations,
    migrationsTableName: 'migrations',
    migrationsTransactionMode: 'each',
    // Schema changes only ever happen through reviewed migrations.
    synchronize: false,
    poolSize,
    // Store and read DATETIME values as UTC, whatever the server's time zone is.
    timezone: 'Z',
    connectTimeout: 5_000,
  };
}

/** MySQL error code of a driver error, also when TypeORM wraps it in QueryFailedError. */
export function mysqlErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; driverError?: { code?: string } } | undefined;
  return e?.driverError?.code ?? e?.code;
}

export const isDuplicateKey = (err: unknown) => mysqlErrorCode(err) === 'ER_DUP_ENTRY';

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Retries a whole transaction when InnoDB aborts it to break a deadlock. A deadlock
 * victim's transaction is rolled back entirely, so running it again is safe.
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !RETRYABLE.has(mysqlErrorCode(err) ?? '')) throw err;
      await sleep(5 * attempt + Math.random() * 10);
    }
  }
}

/** Shape of mysql2's result for INSERT/UPDATE/DELETE when run through `manager.query()`. */
export interface WriteResult {
  affectedRows: number;
}
