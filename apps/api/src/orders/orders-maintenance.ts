import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { WriteResult } from '../database/database.js';

const BATCH = 1_000;

/** Housekeeping on the orders database, run by the worker's cleanup jobs. */
@Injectable()
export class OrdersMaintenance {
  constructor(@InjectDataSource('orders') private readonly db: DataSource) {}

  /** Nobody retries a click from yesterday: forget keys older than `hours`. */
  deleteIdempotencyKeysOlderThan(hours: number): Promise<number> {
    return this.deleteInBatches(
      `DELETE FROM idempotency_keys WHERE created_at < NOW(3) - INTERVAL ? HOUR LIMIT ${BATCH}`,
      [hours],
    );
  }

  /** Published events are only kept for debugging for a while. */
  deletePublishedOutboxOlderThan(days: number): Promise<number> {
    return this.deleteInBatches(
      `DELETE FROM outbox WHERE published_at < NOW(3) - INTERVAL ? DAY LIMIT ${BATCH}`,
      [days],
    );
  }

  /** Small batches keep each DELETE's locks short, so checkout isn't blocked behind cleanup. */
  private async deleteInBatches(sql: string, params: unknown[]): Promise<number> {
    let total = 0;
    for (;;) {
      const result: WriteResult = await this.db.query(sql, params);
      total += result.affectedRows;
      if (result.affectedRows < BATCH) return total;
    }
  }
}
