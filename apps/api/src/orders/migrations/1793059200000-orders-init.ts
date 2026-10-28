import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OrdersInit1793059200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE orders (
        id          CHAR(36) CHARACTER SET ascii NOT NULL,
        user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
        status      ENUM('pending_payment', 'paid', 'cancelled') NOT NULL,
        total_cents INT UNSIGNED NOT NULL,
        created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        -- "My orders, newest first": UUIDv7 ids sort by time, so (user_id, id) serves it directly.
        KEY ix_orders_user (user_id, id)
      ) ENGINE = InnoDB`);

    await q.query(`
      CREATE TABLE order_items (
        order_id         CHAR(36) CHARACTER SET ascii NOT NULL,
        product_id       INT UNSIGNED NOT NULL,
        sku              VARCHAR(64) NOT NULL,
        name             VARCHAR(200) NOT NULL,
        unit_price_cents INT UNSIGNED NOT NULL,
        quantity         INT UNSIGNED NOT NULL,
        PRIMARY KEY (order_id, product_id),
        CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
      ) ENGINE = InnoDB`);

    // Keys are scoped per user, so two customers can never collide on the same key.
    await q.query(`
      CREATE TABLE idempotency_keys (
        user_id       CHAR(36) CHARACTER SET ascii NOT NULL,
        idem_key      VARCHAR(128) CHARACTER SET ascii NOT NULL,
        request_hash  CHAR(64) CHARACTER SET ascii NOT NULL,
        order_id      CHAR(36) CHARACTER SET ascii NOT NULL,
        status        ENUM('in_progress', 'completed') NOT NULL,
        response_body JSON NULL,
        claimed_at    DATETIME(3) NOT NULL,
        created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, idem_key)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE idempotency_keys');
    await q.query('DROP TABLE order_items');
    await q.query('DROP TABLE orders');
  }
}
