import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ENV, type PaymentsEnv } from '../config/env.js';
import type { WriteResult } from '../database/database.js';
import { PaymentsService } from './payments.service.js';
import { WebhookService } from './webhook.service.js';

const KEEP_DAYS = 30;

/**
 * This service's own background jobs: send pending refunds, and delete old audit rows (webhook events, published
 * outbox rows, processed event ids). Expiring unpaid orders is NOT here any more: the shop owns the order deadline
 * and asks us (POST /internal/orders/:id/reconcile) before it cancels.
 */
@Injectable()
export class PaymentJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentJobs.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly payments: PaymentsService,
    private readonly webhooks: WebhookService,
    @Inject(ENV) private readonly env: PaymentsEnv,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), this.env.jobsIntervalSeconds * 1000);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** One round of every job. Exposed for tests. */
  async runOnce() {
    const refunds = await this.payments.sendPendingRefunds();
    const deletedWebhookEvents = await this.webhooks.deleteOlderThan(KEEP_DAYS);
    const outbox: WriteResult = await this.db.query(
      'DELETE FROM outbox WHERE published_at < NOW(3) - INTERVAL ? DAY LIMIT 1000',
      [KEEP_DAYS],
    );
    const processed: WriteResult = await this.db.query(
      'DELETE FROM processed_events WHERE processed_at < NOW(3) - INTERVAL ? DAY LIMIT 1000',
      [KEEP_DAYS],
    );
    return {
      ...refunds,
      deletedWebhookEvents,
      deletedOutbox: outbox.affectedRows,
      deletedProcessedEvents: processed.affectedRows,
    };
  }

  private async tick() {
    // A slow provider can make one round outlast the interval: never run two at once in one process.
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`payment jobs failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
