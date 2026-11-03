import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { OrderLifecycle } from '../orders/order-lifecycle.js';
import { OrdersMaintenance } from '../orders/orders-maintenance.js';

/** A checkout finishes (or is abandoned) within the 30 s load-balancer timeout; 10 min is safe. */
const ORPHAN_RESERVATION_SECONDS = 600;
const IDEMPOTENCY_KEY_HOURS = 24;
const PUBLISHED_OUTBOX_DAYS = 7;

export interface CleanupResult {
  releasedReservations: number;
  committedReservations: number;
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
    private readonly lifecycle: OrderLifecycle,
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
    const reservations = await this.fixStaleReservations();
    const result: CleanupResult = {
      releasedReservations: reservations.released,
      committedReservations: reservations.committed,
      deletedIdempotencyKeys: await this.orders.deleteIdempotencyKeysOlderThan(IDEMPOTENCY_KEY_HOURS),
      deletedOutboxEvents: await this.orders.deletePublishedOutboxOlderThan(PUBLISHED_OUTBOX_DAYS),
    };
    this.metrics.cleanup.inc({ job: 'released_reservations' }, result.releasedReservations);
    this.metrics.cleanup.inc({ job: 'committed_reservations' }, result.committedReservations);
    this.metrics.cleanup.inc({ job: 'idempotency_keys' }, result.deletedIdempotencyKeys);
    this.metrics.cleanup.inc({ job: 'outbox' }, result.deletedOutboxEvents);
    if (result.releasedReservations + result.committedReservations > 0) {
      this.logger.warn(
        `fixed stale stock reservations: released ${result.releasedReservations} (no order or cancelled), ` +
          `committed ${result.committedReservations} (paid)`,
      );
    }
    return result;
  }

  /**
   * Stock still marked "reserved" after 10 minutes, matched against what its order says:
   *
   * - no order: the API crashed between "reserve stock" and "save order" (Phase 1 gap) → release
   * - cancelled: the timeout job cancelled it but crashed before releasing the stock → release
   * - paid: the payment was recorded but the commit step didn't run → commit
   * - pending_payment: still within (or waiting for) the payment timeout → leave alone
   *
   * The order is the source of truth; this makes the stock agree with it eventually.
   */
  private async fixStaleReservations(): Promise<{ released: number; committed: number }> {
    const candidates = await this.inventory.staleReservationOrderIds(ORPHAN_RESERVATION_SECONDS);
    const statuses = await this.lifecycle.statuses(candidates);
    let released = 0;
    let committed = 0;
    for (const orderId of candidates) {
      const status = statuses.get(orderId);
      if (status === undefined || status === 'cancelled') {
        await this.inventory.release(orderId);
        released++;
      } else if (status === 'paid') {
        await this.inventory.commit(orderId);
        committed++;
      }
    }
    return { released, committed };
  }
}
