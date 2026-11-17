import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One "Pay" click: a provider order (Razorpay order) for one of our orders. A customer
 * whose card failed gets a new attempt, so one order can have several.
 */
@Entity({ name: 'payment_attempts' })
export class PaymentAttempt {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  /** 1, 2, 3… per order. UNIQUE (order_id, attempt_no) lets only one of two parallel clicks create it. */
  @Column({ name: 'attempt_no', type: 'tinyint', unsigned: true })
  attemptNo: number;

  /** Null while the provider call is in flight. */
  @Column({ name: 'provider_order_id', type: 'varchar', length: 40, nullable: true })
  providerOrderId: string | null;

  @Column({ name: 'amount_paise', type: 'int', unsigned: true })
  amountPaise: number;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

/**
 * captured = money taken and kept · failed = the attempt didn't go through ·
 * refund_pending = we took money we must give back · refunded = given back.
 */
export type PaymentStatus = 'failed' | 'captured' | 'refund_pending' | 'refunded';

/** order_cancelled = paid after the timeout · paid_twice = the order was already paid · amount_mismatch */
export type RefundReason = 'order_cancelled' | 'paid_twice' | 'amount_mismatch';

/** One payment the provider told us about (by webhook, the browser, or reconciliation). */
@Entity({ name: 'payments' })
export class Payment {
  /** The provider's payment id (pay_…): the same payment reported twice is the same row. */
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ name: 'attempt_id', type: 'char', length: 36 })
  attemptId: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @Column({ name: 'amount_paise', type: 'int', unsigned: true })
  amountPaise: number;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: ['failed', 'captured', 'refund_pending', 'refunded'] })
  status: PaymentStatus;

  @Column({ name: 'refund_reason', type: 'varchar', length: 32, nullable: true })
  refundReason: RefundReason | null;

  @Column({ name: 'refund_id', type: 'varchar', length: 40, nullable: true })
  refundId: string | null;

  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  errorCode: string | null;

  @Column({ name: 'error_description', type: 'varchar', length: 255, nullable: true })
  errorDescription: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

/** Every webhook delivery we accepted, by the provider's event id: spots repeats, and an audit trail. */
@Entity({ name: 'webhook_events' })
export class WebhookEvent {
  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 64 })
  eventId: string;

  @Column({ type: 'varchar', length: 64 })
  event: string;

  @Column({ type: 'json' })
  payload: unknown;

  /** What processing did (paid, refund, ignored…). Null = received but not finished. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  outcome: string | null;

  /** How many times the provider delivered this event. */
  @Column({ type: 'int', unsigned: true, default: 1 })
  deliveries: number;

  @CreateDateColumn({ name: 'received_at', type: 'datetime', precision: 3 })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'datetime', precision: 3, nullable: true })
  processedAt: Date | null;
}
