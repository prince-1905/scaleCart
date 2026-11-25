import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * E17: the email worker CLAIMS an event before sending (status 'sending'), and marks it 'sent' afterwards. Before,
 * it checked "already sent?", sent, then recorded: copies of the same event handled at the same moment all passed the
 * check (196 emails for 20 orders in a redelivery storm). Existing rows were all sent.
 */
export class NotificationClaims1795500000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE sent_notifications
        ADD COLUMN status ENUM('sending', 'sent') NOT NULL DEFAULT 'sent' AFTER recipient,
        ADD COLUMN claimed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER status,
        MODIFY sent_at DATETIME(3) NULL DEFAULT NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM sent_notifications WHERE status = 'sending'`);
    await q.query(`
      ALTER TABLE sent_notifications
        DROP COLUMN status,
        DROP COLUMN claimed_at,
        MODIFY sent_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
  }
}
