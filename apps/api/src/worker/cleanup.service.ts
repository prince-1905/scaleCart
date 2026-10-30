import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { OrdersMaintenance } from '../orders/orders-maintenance.js';

/** A checkout finishes (or is abandoned) within the 30 s load-balancer timeout; 10 min is safe. */
const ORPHAN_RESERVATION_SECONDS = 600;
const IDEMPOTENCY_KEY_HOURS = 24;
const PUBLISHED_OUTBOX_DAYS = 7;

export interface CleanupResult {
  releasedReservations: number;
  deletedIdempotencyKeys: number;
  deletedOutboxEvents: number;
}

/**
 * Periodic housekeeping (runs in the worker). Every job is safe to run twice at the
 * same time, so several worker replicas need no coordination: releasing a reservation
 * locks its rows and only acts on status 'reserved'; deletes simply find nothing.
 */
@Injectable()
export class CleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly inventory: InventoryService,
    private readonly orders: OrdersMaintenance,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error(`cleanup failed: ${(err as Error).message}`));
    }, this.env.cleanupIntervalSeconds * 1000);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async runOnce(): Promise<CleanupResult> {
    const result: CleanupResult = {
      releasedReservations: await this.releaseOrphanReservations(),
      deletedIdempotencyKeys: await this.orders.deleteIdempotencyKeysOlderThan(IDEMPOTENCY_KEY_HOURS),
      deletedOutboxEvents: await this.orders.deletePublishedOutboxOlderThan(PUBLISHED_OUTBOX_DAYS),
    };
    this.metrics.cleanup.inc({ job: 'orphan_reservations' }, result.releasedReservations);
    this.metrics.cleanup.inc({ job: 'idempotency_keys' }, result.deletedIdempotencyKeys);
    this.metrics.cleanup.inc({ job: 'outbox' }, result.deletedOutboxEvents);
    if (result.releasedReservations > 0) {
      this.logger.warn(`released stock held by ${result.releasedReservations} orders that were never created`);
    }
    return result;
  }

  /**
   * Closes the Phase 1 gap: if the API crashed between "reserve stock" and "save order",
   * the stock stayed reserved forever. A reservation older than 10 minutes whose order
   * doesn't exist is an orphan: give the stock back.
   */
  private async releaseOrphanReservations(): Promise<number> {
    const candidates = await this.inventory.staleReservationOrderIds(ORPHAN_RESERVATION_SECONDS);
    const existing = await this.orders.existingOrderIds(candidates);
    const orphans = candidates.filter((id) => !existing.has(id));
    for (const orderId of orphans) await this.inventory.release(orderId);
    return orphans.length;
  }
}
