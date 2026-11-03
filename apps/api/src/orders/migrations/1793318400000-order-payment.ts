import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderPayment1793318400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE orders
        -- The provider payment that paid this order. A second payment for the same order
        -- is told apart from a repeat of the first by this id.
        ADD COLUMN payment_id VARCHAR(40) CHARACTER SET ascii NULL AFTER total_cents,
        -- The payment-timeout job: "pending_payment and older than 15 minutes".
        ADD KEY ix_orders_status_created (status, created_at)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE orders DROP KEY ix_orders_status_created, DROP COLUMN payment_id');
  }
}
