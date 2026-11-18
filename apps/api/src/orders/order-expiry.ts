import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DropPurchases } from '../drops/drop-purchases.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { OrderLifecycle } from './order-lifecycle.js';
import { PaymentsClient } from './payments-client.js';

const BATCH = 100;
/** Leaves room inside the 30 s job interval. */
const ROUND_MS = 20_000;

/**
 * Cancels unpaid orders past their deadline and gives their stock back (runs in the worker). Before 2026-11 this
 * lived in the payments module; since the split the shop owns the deadline and asks the payments service first:
 *
 *   for each overdue order:  payments says "paid after all"   → leave it (payment.captured is on its way)
 *                            payments can't answer              → leave it, try next round (never cancel unchecked)
 *                            payments says "not paid"           → cancel (conditional UPDATE), release stock and the
 *                                                                 drop purchase
 * Safe on several workers: cancelling is a conditional UPDATE, releasing is idempotent.
 */
@Injectable()
export class OrderExpiry implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrderExpiry.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly orders: OrderLifecycle,
    private readonly payments: PaymentsClient,
    private readonly inventory: InventoryService,
    private readonly dropPurchases: DropPurchases,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), this.env.paymentJobsIntervalSeconds * 1000);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** One round. Batches until none are left, the round's time is up, or a batch changed nothing (payments down). */
  async runOnce(): Promise<{ cancelled: number; keptPaid: number; skipped: number }> {
    const result = { cancelled: 0, keptPaid: 0, skipped: 0 };
    const started = Date.now();
    const skipped = new Set<string>();
    for (;;) {
      const batch = (await this.orders.overdue(this.env.paymentTimeoutSeconds, BATCH + skipped.size)).filter(
        (id) => !skipped.has(id),
      );
      const before = result.cancelled;
      for (const orderId of batch.slice(0, BATCH)) {
        let paid: boolean;
        try {
          paid = await this.payments.paidAfterAll(orderId);
        } catch (err) {
          result.skipped++;
          skipped.add(orderId);
          if (result.skipped === 1) this.logger.warn(`cannot check payments for overdue orders: ${(err as Error).message}`);
          continue;
        }
        if (paid) {
          result.keptPaid++;
          skipped.add(orderId);
          continue;
        }
        if (await this.orders.cancelIfUnpaid(orderId)) {
          await this.inventory.release(orderId);
          // Not bought after all: a drop customer may try that drop again.
          await this.dropPurchases.releaseOrder(orderId);
          result.cancelled++;
        }
      }
      if (batch.length < BATCH || result.cancelled === before || Date.now() - started > ROUND_MS) break;
    }
    if (result.cancelled) this.logger.log(`expired ${result.cancelled} unpaid order(s) in ${Date.now() - started} ms`);
    this.metrics.paymentJobs.inc({ job: 'expired_orders' }, result.cancelled);
    this.metrics.paymentJobs.inc({ job: 'expiry_skipped' }, result.skipped);
    return result;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`order expiry failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
