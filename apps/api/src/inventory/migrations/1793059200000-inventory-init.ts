import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InventoryInit1793059200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE stock (
        product_id INT UNSIGNED NOT NULL,
        available  INT UNSIGNED NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (product_id)
      ) ENGINE = InnoDB`);

    await q.query(`
      CREATE TABLE reservations (
        order_id   CHAR(36) CHARACTER SET ascii NOT NULL,
        product_id INT UNSIGNED NOT NULL,
        quantity   INT UNSIGNED NOT NULL,
        status     ENUM('reserved', 'released', 'committed') NOT NULL DEFAULT 'reserved',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (order_id, product_id),
        KEY ix_reservations_status_created (status, created_at)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE reservations');
    await q.query('DROP TABLE stock');
  }
}
