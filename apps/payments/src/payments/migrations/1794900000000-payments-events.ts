import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 8: payments is its own service and talks to the shop with events.
 *
 * outbox            events to publish (payment.captured…), written in the same transaction as the payment row,
 *                   so "payment saved" and "event will be sent" can't disagree. A relay publishes them.
 * processed_events  event ids this service already handled (order.payment_result…): RabbitMQ delivers at least
 *                   once, so a repeat must be recognised and skipped (the "inbox").
 */
export class PaymentsEvents1794900000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE outbox (
        id           CHAR(36) CHARACTER SET ascii NOT NULL,
        event_type   VARCHAR(100) CHARACTER SET ascii NOT NULL,
        aggregate_id CHAR(36) CHARACTER SET ascii NOT NULL,
        payload      JSON NOT NULL,
        created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        published_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_outbox_unpublished (published_at, id)
      ) ENGINE = InnoDB`);

    await q.query(`
      CREATE TABLE processed_events (
        event_id     CHAR(36) CHARACTER SET ascii NOT NULL,
        event_type   VARCHAR(100) CHARACTER SET ascii NOT NULL,
        processed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (event_id),
        KEY ix_processed_events_at (processed_at)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE processed_events');
    await q.query('DROP TABLE outbox');
  }
}
