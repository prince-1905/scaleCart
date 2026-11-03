import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { WriteResult } from '../database/database.js';
import type { OrderStatus } from './order.entity.js';

export interface OrderSummary {
  id: string;
  userId: string;
  status: OrderStatus;
  totalCents: number;
  paymentId: string | null;
  createdAt: Date;
}

/**
 * paid            this payment just paid the order
 * already_paid    this same payment paid it before (a repeat: webhook + browser, or a redelivery)
 * paid_by_other   another payment paid it first: this one must be refunded
 * cancelled       the order timed out before the money arrived: refund
 */
export type MarkPaidResult = 'paid' | 'already_paid' | 'paid_by_other' | 'cancelled' | 'not_found';

/**
 * The order's state machine: pending_payment → paid | cancelled, nothing else.
 *
 * Every change is ONE conditional UPDATE (`WHERE status = 'pending_payment'`). When a
 * late payment and the timeout job race for the same order, InnoDB lets exactly one
 * of them change the row; the loser sees 0 affected rows and knows it lost. The order
 * row is the single place that decides, so "paid AND cancelled" can't happen.
 */
@Injectable()
export class OrderLifecycle {
  constructor(@InjectDataSource('orders') private readonly db: DataSource) {}

  async get(orderId: string): Promise<OrderSummary | null> {
    const [row] = await this.db.query(
      `SELECT id, user_id AS userId, status, total_cents AS totalCents, payment_id AS paymentId, created_at AS createdAt
         FROM orders WHERE id = ?`,
      [orderId],
    );
    return row ?? null;
  }

  async markPaid(orderId: string, paymentId: string): Promise<MarkPaidResult> {
    const result: WriteResult = await this.db.query(
      `UPDATE orders SET status = 'paid', payment_id = ? WHERE id = ? AND status = 'pending_payment'`,
      [paymentId, orderId],
    );
    if (result.affectedRows === 1) return 'paid';

    // Lost (or repeated): find out why. The row can't go back to pending, so this read is stable.
    const order = await this.get(orderId);
    if (!order) return 'not_found';
    if (order.status === 'cancelled') return 'cancelled';
    return order.paymentId === paymentId ? 'already_paid' : 'paid_by_other';
  }

  /** Cancels an order that is still unpaid. False = it was paid (or cancelled) in the meantime. */
  async cancelIfUnpaid(orderId: string): Promise<boolean> {
    const result: WriteResult = await this.db.query(
      `UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'`,
      [orderId],
    );
    return result.affectedRows === 1;
  }

  /** Unpaid orders past their payment deadline, oldest first. Database clock, like checkout. */
  async overdue(olderThanSeconds: number, limit = 100): Promise<string[]> {
    const rows: { id: string }[] = await this.db.query(
      `SELECT id FROM orders
        WHERE status = 'pending_payment' AND created_at < NOW(3) - INTERVAL ? SECOND
        ORDER BY created_at LIMIT ?`,
      [olderThanSeconds, limit],
    );
    return rows.map((r) => r.id);
  }

  /** Status of each of these orders; missing ids aren't in the map. */
  async statuses(ids: string[]): Promise<Map<string, OrderStatus>> {
    if (ids.length === 0) return new Map();
    const rows: { id: string; status: OrderStatus }[] = await this.db.query(
      'SELECT id, status FROM orders WHERE id IN (?)',
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r.status]));
  }
}
