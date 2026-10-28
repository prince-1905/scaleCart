import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ENV, type Env, type StockReservationStrategy } from '../config/env.js';
import { isDuplicateKey, retryOnDeadlock, type WriteResult } from '../database/database.js';
import { Stock } from './stock.entity.js';

export interface StockLine {
  productId: number;
  quantity: number;
}

export class OutOfStockError extends Error {
  constructor(readonly productId: number) {
    super(`product ${productId} is out of stock`);
  }
}

/** The inventory module's public API. Only this module reads or writes stock. */
@Injectable()
export class InventoryService {
  private readonly strategy: StockReservationStrategy;

  constructor(
    @InjectDataSource('inventory') private readonly db: DataSource,
    @Inject(ENV) env: Env,
  ) {
    this.strategy = env.stockReservation;
  }

  async getAvailable(productId: number): Promise<number | null> {
    const row = await this.db.getRepository(Stock).findOneBy({ productId });
    return row?.available ?? null;
  }

  async setAvailable(productId: number, available: number): Promise<void> {
    await this.db.query(
      `INSERT INTO stock (product_id, available) VALUES (?, ?) AS new
         ON DUPLICATE KEY UPDATE available = new.available`,
      [productId, available],
    );
  }

  /**
   * Takes stock for every line of an order, all or nothing (one transaction).
   *
   * - Lines are locked in product-id order, so two orders for the same products
   *   can't each hold one row and wait for the other's (deadlock).
   * - Safe to repeat: the reservation rows' primary key (order_id, product_id)
   *   makes a second attempt for the same order a no-op.
   *
   * @throws OutOfStockError and changes nothing, if any line can't be filled.
   */
  async reserve(orderId: string, lines: StockLine[]): Promise<void> {
    const sorted = [...lines].sort((a, b) => a.productId - b.productId);
    await retryOnDeadlock(() =>
      this.db.transaction(async (m) => {
        try {
          await m.query(
            `INSERT INTO reservations (order_id, product_id, quantity)
             VALUES ${sorted.map(() => '(?, ?, ?)').join(', ')}`,
            sorted.flatMap((l) => [orderId, l.productId, l.quantity]),
          );
        } catch (err) {
          if (isDuplicateKey(err)) return; // this order already holds its stock
          throw err;
        }
        for (const line of sorted) {
          if (!(await this.take(m, line))) throw new OutOfStockError(line.productId);
        }
      }),
    );
  }

  /** Gives an order's stock back (compensation when checkout fails later). Safe to repeat. */
  async release(orderId: string): Promise<void> {
    await retryOnDeadlock(() =>
      this.db.transaction(async (m) => {
        const rows: StockLine[] = await m.query(
          `SELECT product_id AS productId, quantity FROM reservations
            WHERE order_id = ? AND status = 'reserved'
            ORDER BY product_id FOR UPDATE`,
          [orderId],
        );
        for (const r of rows) {
          await m.query('UPDATE stock SET available = available + ? WHERE product_id = ?', [
            r.quantity,
            r.productId,
          ]);
        }
        await m.query(
          `UPDATE reservations SET status = 'released' WHERE order_id = ? AND status = 'reserved'`,
          [orderId],
        );
      }),
    );
  }

  private async take(m: EntityManager, { productId, quantity }: StockLine): Promise<boolean> {
    switch (this.strategy) {
      case 'atomic': {
        // Check and decrement in ONE statement. InnoDB locks the row and evaluates the
        // WHERE against the latest committed value, so there is no gap between "is
        // there enough?" and "take it" for another buyer to slip into.
        const result: WriteResult = await m.query(
          `UPDATE stock SET available = available - ?
            WHERE product_id = ? AND available >= ?`,
          [quantity, productId, quantity],
        );
        return result.affectedRows === 1;
      }

      case 'locking': {
        // Pessimistic lock: FOR UPDATE makes other buyers wait here until we commit.
        // Correct, but the lock is held across two round trips instead of one.
        const [row] = await m.query(
          'SELECT available FROM stock WHERE product_id = ? FOR UPDATE',
          [productId],
        );
        if (!row || row.available < quantity) return false;
        await m.query('UPDATE stock SET available = ? WHERE product_id = ?', [
          row.available - quantity,
          productId,
        ]);
        return true;
      }

      case 'naive': {
        // BROKEN ON PURPOSE (lab only). Read, decide in Node, write the computed value.
        // Many buyers read "100" at the same time, each writes 99: a lost update.
        const [row] = await m.query('SELECT available FROM stock WHERE product_id = ?', [
          productId,
        ]);
        if (!row || row.available < quantity) return false;
        await m.query('UPDATE stock SET available = ? WHERE product_id = ?', [
          row.available - quantity,
          productId,
        ]);
        return true;
      }
    }
  }
}
