import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PaymentsService } from './payments.service.js';
import { WebhookService } from './webhook.service.js';

const WEBHOOK_EVENT_DAYS = 30;

/**
 * The worker's payment jobs: expire unpaid orders (after checking with the provider)
 * and send pending refunds. Safe on several workers at once: cancelling is a conditional
 * UPDATE, and refunds carry a receipt the provider won't accept twice.
 */
@Injectable()
export class PaymentJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentJobs.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly payments: PaymentsService,
    private readonly webhooks: WebhookService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), this.env.paymentJobsIntervalSeconds * 1000);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** One round of every job. Exposed for tests. */
  async runOnce() {
    const expired = await this.payments.expireOverdueOrders();
    const refunds = await this.payments.sendPendingRefunds();
    const deletedWebhookEvents = await this.webhooks.deleteOlderThan(WEBHOOK_EVENT_DAYS);
    return { ...expired, ...refunds, deletedWebhookEvents };
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
