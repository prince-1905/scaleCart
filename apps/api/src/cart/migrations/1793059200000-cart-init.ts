import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CartInit1793059200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // No foreign keys to users or products: they live in other modules' databases.
    // Cross-module integrity is checked by the application (and later by events).
    await q.query(`
      CREATE TABLE cart_items (
        user_id    CHAR(36) CHARACTER SET ascii NOT NULL,
        product_id INT UNSIGNED NOT NULL,
        quantity   INT UNSIGNED NOT NULL,
        added_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, product_id)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE cart_items');
  }
}
