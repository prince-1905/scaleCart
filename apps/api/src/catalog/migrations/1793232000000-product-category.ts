import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductCategory1793232000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // NULL = uncategorised (the 200k load-test products). The index serves
    // "category = ? AND price BETWEEN ? AND ?" filters without scanning the table.
    await q.query(`
      ALTER TABLE products
        ADD COLUMN category VARCHAR(40) NULL AFTER description,
        ADD KEY ix_products_category_price (category, price_cents)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE products DROP KEY ix_products_category_price, DROP COLUMN category');
  }
}
