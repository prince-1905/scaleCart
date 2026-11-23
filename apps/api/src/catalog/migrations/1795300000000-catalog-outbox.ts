import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 12 (search, CQRS): the catalog's own outbox. A product write and its "product.changed" event are saved in
 * the SAME transaction, so the search copy can never miss a change (or hear about one that was rolled back). The
 * worker's relay publishes the rows; the indexer updates OpenSearch.
 */
export class CatalogOutbox1795300000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE outbox (
        id           CHAR(36) CHARACTER SET ascii NOT NULL,
        event_type   VARCHAR(100) CHARACTER SET ascii NOT NULL,
        aggregate_id CHAR(36) CHARACTER SET ascii NOT NULL,
        payload      JSON NOT NULL,
        trace_parent VARCHAR(55) CHARACTER SET ascii NULL,
        created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        published_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_outbox_unpublished (published_at, id)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE outbox');
  }
}
