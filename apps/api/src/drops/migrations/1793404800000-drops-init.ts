import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DropsInit1793404800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE drops (
        id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
        product_id       INT UNSIGNED NOT NULL,
        name             VARCHAR(200) NOT NULL,
        starts_at        DATETIME(3) NOT NULL,
        max_per_customer TINYINT UNSIGNED NOT NULL,
        admit_per_second INT UNSIGNED NOT NULL,
        created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_drops_product (product_id),
        KEY ix_drops_starts (starts_at)
      ) ENGINE = InnoDB`);

    // The primary key is the rule: one purchase per customer per drop. Of two checkouts
    // racing for the same customer, only one INSERT wins.
    await q.query(`
      CREATE TABLE drop_purchases (
        drop_id    INT UNSIGNED NOT NULL,
        user_id    CHAR(36) CHARACTER SET ascii NOT NULL,
        order_id   CHAR(36) CHARACTER SET ascii NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (drop_id, user_id)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE drop_purchases');
    await q.query('DROP TABLE drops');
  }
}
