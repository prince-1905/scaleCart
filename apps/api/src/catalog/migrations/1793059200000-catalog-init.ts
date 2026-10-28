import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CatalogInit1793059200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // FULLTEXT: an inverted index (word -> rows), so a keyword search doesn't scan
    // every row the way LIKE '%word%' must (experiment E1).
    await q.query(`
      CREATE TABLE products (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        sku         VARCHAR(64) NOT NULL,
        name        VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        price_cents INT UNSIGNED NOT NULL,
        created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_products_sku (sku),
        FULLTEXT KEY ft_products_text (name, description)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE products');
  }
}
