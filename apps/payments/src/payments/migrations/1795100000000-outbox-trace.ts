import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 (tracing): the W3C traceparent of the request that wrote the event ("00-<trace id>-<span id>-01"), so the
 * relay can publish the event as part of that request's trace. NULL when tracing is off.
 */
export class PaymentsOutboxTrace1795100000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE outbox ADD COLUMN trace_parent VARCHAR(55) CHARACTER SET ascii NULL AFTER payload');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE outbox DROP COLUMN trace_parent');
  }
}
