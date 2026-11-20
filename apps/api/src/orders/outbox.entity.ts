import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** An event waiting to be (or already) published to RabbitMQ. */
@Entity({ name: 'outbox' })
export class OutboxEvent {
  /** UUIDv7. Also the RabbitMQ message id, which consumers use to drop duplicates. */
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType: string;

  @Column({ name: 'aggregate_id', type: 'char', length: 36 })
  aggregateId: string;

  @Column({ type: 'json' })
  payload: unknown;

  /** W3C traceparent of the request that wrote it (Phase 10), so the relay publishes it inside that trace. */
  @Column({ name: 'trace_parent', type: 'varchar', length: 55, nullable: true })
  traceParent?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @Column({ name: 'published_at', type: 'datetime', precision: 3, nullable: true })
  publishedAt: Date | null;
}
