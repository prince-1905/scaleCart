import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 13 (read replica): one row the worker stamps with the primary's time every 250 ms. Read on the replica,
 * "now minus the stamp" says how far behind the copy is (the heartbeat method, like Percona's pt-heartbeat). It lives
 * in the orders database because "My orders" is the read that cares most about freshness.
 */
export class ReplicationHeartbeat1795400000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE replication_heartbeat (
        id      TINYINT UNSIGNED NOT NULL,
        beat_at DATETIME(6) NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE replication_heartbeat');
  }
}
