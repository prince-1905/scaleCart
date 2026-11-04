import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DropMaxShoppers1793491200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // NULL = the line moves at admit_per_second (time-based). A number = "one out, one in" with that many places.
    await q.query('ALTER TABLE drops ADD COLUMN max_shoppers INT UNSIGNED NULL AFTER admit_per_second');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE drops DROP COLUMN max_shoppers');
  }
}
