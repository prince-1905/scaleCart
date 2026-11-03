import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PaymentsInit1793318400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE payment_attempts (
        id                CHAR(36) CHARACTER SET ascii NOT NULL,
        order_id          CHAR(36) CHARACTER SET ascii NOT NULL,
        user_id           CHAR(36) CHARACTER SET ascii NOT NULL,
        attempt_no        TINYINT UNSIGNED NOT NULL,
        provider_order_id VARCHAR(40) CHARACTER SET ascii NULL,
        amount_paise      INT UNSIGNED NOT NULL,
        currency          CHAR(3) CHARACTER SET ascii NOT NULL,
        created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        -- Two "Pay" clicks at once: only one INSERT of attempt N wins.
        UNIQUE KEY uq_attempts_order_no (order_id, attempt_no),
        -- Webhooks name the provider order: find our attempt from it.
        UNIQUE KEY uq_attempts_provider_order (provider_order_id)
      ) ENGINE = InnoDB`);

    await q.query(`
      CREATE TABLE payments (
        id                VARCHAR(40) CHARACTER SET ascii NOT NULL,
        attempt_id        CHAR(36) CHARACTER SET ascii NOT NULL,
        order_id          CHAR(36) CHARACTER SET ascii NOT NULL,
        amount_paise      INT UNSIGNED NOT NULL,
        currency          CHAR(3) CHARACTER SET ascii NOT NULL,
        status            ENUM('failed', 'captured', 'refund_pending', 'refunded') NOT NULL,
        refund_reason     VARCHAR(32) NULL,
        refund_id         VARCHAR(40) CHARACTER SET ascii NULL,
        error_code        VARCHAR(64) NULL,
        error_description VARCHAR(255) NULL,
        created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY ix_payments_order (order_id),
        -- The refund job: "refund_pending, oldest first".
        KEY ix_payments_status (status, updated_at)
      ) ENGINE = InnoDB`);

    await q.query(`
      CREATE TABLE webhook_events (
        event_id     VARCHAR(64) CHARACTER SET ascii NOT NULL,
        event        VARCHAR(64) NOT NULL,
        payload      JSON NOT NULL,
        outcome      VARCHAR(32) NULL,
        deliveries   INT UNSIGNED NOT NULL DEFAULT 1,
        received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        processed_at DATETIME(3) NULL,
        PRIMARY KEY (event_id),
        KEY ix_webhook_events_received (received_at)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE webhook_events');
    await q.query('DROP TABLE payments');
    await q.query('DROP TABLE payment_attempts');
  }
}
