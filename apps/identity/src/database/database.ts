import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSourceOptions } from 'typeorm';
import type { DbConfig } from '../config/env.js';
import { IdentityInit1793059200000 } from '../identity/migrations/1793059200000-identity-init.js';
import { IdentityTwoFactor1794800000000 } from '../identity/migrations/1794800000000-identity-two-factor.js';
import { RefreshToken } from '../identity/refresh-token.entity.js';
import { User } from '../identity/user.entity.js';

/**
 * The connection is named "identity", as when identity was a module of the shop, so the moved code
 * (@InjectRepository(User, 'identity')) didn't change.
 */
export const CONNECTION = 'identity';

export function mysqlOptions(db: DbConfig, poolSize: number = db.poolSize): DataSourceOptions {
  return {
    type: 'mysql',
    host: db.host,
    port: db.port,
    username: db.user,
    password: db.password,
    database: db.database,
    entities: [User, RefreshToken],
    // Same migrations table as when identity lived in the shop: these migrations are already applied there.
    migrations: [IdentityInit1793059200000, IdentityTwoFactor1794800000000],
    migrationsTableName: 'migrations',
    migrationsTransactionMode: 'each',
    synchronize: false,
    poolSize,
    timezone: 'Z',
    connectTimeout: 5_000,
  };
}

export function mysqlErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; driverError?: { code?: string } } | undefined;
  return e?.driverError?.code ?? e?.code;
}

export const isDuplicateKey = (err: unknown) => mysqlErrorCode(err) === 'ER_DUP_ENTRY';

export interface WriteResult {
  affectedRows: number;
}

export async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(delayMs);
    }
  }
}
