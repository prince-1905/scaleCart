import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Gauge } from 'prom-client';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { withTraceparent } from '../common/trace-context.js';
import { RabbitService } from '../messaging/rabbit.service.js';
import { MetricsService } from '../observability/metrics.service.js';

const BATCH = 100;
/** How often to look for new events when the outbox is empty (the upper bound on added delay). */
const POLL_MS = 200;

interface OutboxRow {
  id: string;
  eventType: string;
  payload: unknown;
  traceParent: string | null;
  createdAt: Date;
}

/**
 * Moves events from the outbox table to RabbitMQ (runs in the worker).
 *
 * 1. In a transaction, lock up to 100 unpublished rows with FOR UPDATE SKIP LOCKED.
 *    SKIP LOCKED lets several worker replicas share the work: each takes rows the
 *    others haven't locked, instead of waiting for them.
 * 2. Publish them and wait for RabbitMQ's confirm (= stored on disk).
 * 3. Mark them published and commit.
 *
 * Crash between 2 and 3? The rows are still unpublished and get sent again:
 * **at-least-once** delivery. Consumers must therefore ignore duplicates (they do,
 * by event id). Exactly-once delivery isn't on offer; idempotent consumers are.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop?: Promise<void>;

  /** Every outbox this relay empties: orders (order.created, order.payment_result) and, since Phase 12, catalog. */
  private readonly sources: { name: string; db: DataSource }[];

  constructor(
    @InjectDataSource('orders') ordersDb: DataSource,
    @InjectDataSource('catalog') catalogDb: DataSource,
    private readonly rabbit: RabbitService,
    private readonly metrics: MetricsService,
  ) {
    this.sources = [
      { name: 'orders', db: ordersDb },
      { name: 'catalog', db: catalogDb },
    ];
    const sources = this.sources;
    new Gauge({
      name: 'outbox_pending_events',
      help: 'Outbox events not yet published to RabbitMQ (backlog), per outbox.',
      labelNames: ['source'] as const,
      registers: [metrics.registry],
      async collect() {
        for (const s of sources) {
          const [row] = await s.db.query('SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL');
          this.set({ source: s.name }, Number(row.n));
        }
      },
    });
  }

  onApplicationBootstrap() {
    this.running = true;
    void this.rabbit.start();
    this.loop = this.run();
  }

  async onApplicationShutdown() {
    this.running = false;
    await this.loop;
  }

  /** Publishes one batch from each outbox. Returns how many events were published in total. */
  async publishBatch(): Promise<number> {
    let total = 0;
    for (const source of this.sources) total += await this.publishFrom(source.db);
    return total;
  }

  private async publishFrom(db: DataSource): Promise<number> {
    if (!this.rabbit.isReady) return 0;
    return db.transaction(async (m) => {
      const rows: OutboxRow[] = await m.query(
        `SELECT id, event_type AS eventType, payload, trace_parent AS traceParent, created_at AS createdAt
           FROM outbox WHERE published_at IS NULL
          ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
        [BATCH],
      );
      if (rows.length === 0) return 0;

      for (const row of rows) {
        // Inside the trace of the request that wrote the event: the RabbitMQ instrumentation adds it to the message
        // headers, and the consumer continues the same trace (no-op when tracing is off).
        withTraceparent(row.traceParent, () =>
          this.rabbit.publishEvent(row.eventType, row.payload, {
            messageId: row.id,
            type: row.eventType,
            timestamp: Math.floor(new Date(row.createdAt).getTime() / 1000),
            // Milliseconds (AMQP timestamps are whole seconds): the search indexer measures its lag with it.
            headers: { 'x-created-ms': new Date(row.createdAt).getTime() },
          }),
        );
      }
      await this.rabbit.confirm();

      await m.query('UPDATE outbox SET published_at = NOW(3) WHERE id IN (?)', [rows.map((r) => r.id)]);
      this.metrics.outboxPublished.inc(rows.length);
      return rows.length;
    });
  }

  private async run() {
    while (this.running) {
      let published = 0;
      try {
        published = await this.publishBatch();
      } catch (err) {
        // Rolled back: the rows stay unpublished and are retried.
        this.logger.warn(`outbox publish failed, will retry: ${(err as Error).message}`);
        await sleep(1_000);
        continue;
      }
      // A full batch means there is probably more waiting: go again immediately.
      if (published < BATCH) await sleep(POLL_MS);
    }
  }
}
