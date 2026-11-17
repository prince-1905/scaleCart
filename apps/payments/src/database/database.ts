import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSourceOptions } from 'typeorm';
import type { DbConfig } from '../config/env.js';
import { PaymentsInit1793318400000 } from '../payments/migrations/1793318400000-payments-init.js';
import { PaymentsEvents1794900000000 } from '../payments/migrations/1794900000000-payments-events.js';
import { Payment, PaymentAttempt, WebhookEvent } from '../payments/payment.entities.js';

export function mysqlOptions(db: DbConfig, poolSize: number = db.poolSize): DataSourceOptions {
  return {
    type: 'mysql',
    host: db.host,
    port: db.port,
    username: db.user,
    password: db.password,
    database: db.database,
    entities: [PaymentAttempt, Payment, WebhookEvent],
    // Same migrations table as when payments lived in the shop: the first migration is already applied there.
    migrations: [PaymentsInit1793318400000, PaymentsEvents1794900000000],
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

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/** Runs a whole transaction again when InnoDB aborted it to break a deadlock. */
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
