import type { MigrationInterface, QueryRunner } from 'typeorm';

export class NotificationsInit1793145600000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // One row per event already handled: RabbitMQ delivers at least once, so the
    // consumer checks here first and skips duplicates (idempotent consumer).
    await q.query(`
      CREATE TABLE sent_notifications (
        event_id  CHAR(36) CHARACTER SET ascii NOT NULL,
        order_id  CHAR(36) CHARACTER SET ascii NOT NULL,
        recipient VARCHAR(254) NOT NULL,
        sent_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (event_id),
        KEY ix_sent_notifications_order (order_id)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE sent_notifications');
  }
}
