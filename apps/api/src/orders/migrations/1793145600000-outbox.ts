import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Outbox1793145600000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Transactional outbox: events are written in the SAME transaction as the order,
    // so "order saved but event lost" (or the reverse) can't happen. A relay publishes
    // unpublished rows to RabbitMQ afterwards.
    await q.query(`
      CREATE TABLE outbox (
        id           CHAR(36) CHARACTER SET ascii NOT NULL,
        event_type   VARCHAR(100) CHARACTER SET ascii NOT NULL,
        aggregate_id CHAR(36) CHARACTER SET ascii NOT NULL,
        payload      JSON NOT NULL,
        created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        published_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        -- "next unpublished events, oldest first" without scanning published history.
        KEY ix_outbox_unpublished (published_at, id)
      ) ENGINE = InnoDB`);

    // For the cleanup job that deletes keys older than 24 h.
    await q.query('CREATE INDEX ix_idempotency_keys_created ON idempotency_keys (created_at)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX ix_idempotency_keys_created ON idempotency_keys');
    await q.query('DROP TABLE outbox');
  }
}
