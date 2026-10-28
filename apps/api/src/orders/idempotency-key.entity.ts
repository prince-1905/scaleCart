import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Remembers each checkout attempt by the client's Idempotency-Key, so a retry
 * (double click, timeout, flaky network) gets the first answer instead of a second order.
 */
@Entity({ name: 'idempotency_keys' })
export class IdempotencyKey {
  @PrimaryColumn({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  @PrimaryColumn({ name: 'idem_key', type: 'varchar', length: 128 })
  key: string;

  /** SHA-256 of the request body: the same key with a different request is a client bug. */
  @Column({ name: 'request_hash', type: 'char', length: 64 })
  requestHash: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @Column({ type: 'enum', enum: ['in_progress', 'completed'] })
  status: 'in_progress' | 'completed';

  @Column({ name: 'response_body', type: 'json', nullable: true })
  responseBody: unknown;

  @Column({ name: 'claimed_at', type: 'datetime', precision: 3 })
  claimedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
