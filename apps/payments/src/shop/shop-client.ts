import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENV, type PaymentsEnv } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

/** What the shop tells us about one order (GET /internal/orders/:id). */
export interface ShopOrder {
  id: string;
  userId: string;
  status: 'pending_payment' | 'paid' | 'cancelled';
  totalCents: number;
  /** The shop owns the deadline: unpaid after this, the order is cancelled. */
  payBy: string;
}

class ShopError extends Error {
  constructor(
    message: string,
    /** Worth trying again: the network or the shop's own failure (5xx), not "no such order" (404). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * The one synchronous call from payments to the shop: "how much is order X, whose is it, still unpaid?", needed
 * the moment a customer clicks Pay. Every call has:
 *   - a timeout (SHOP_TIMEOUT_MS, 1 s): never hang a customer's request on a slow shop
 *   - one retry, only for timeouts / network errors / 5xx, after 100 ms
 *   - a circuit breaker: 5 failures in a row → refuse at once for 10 s, then one trial call
 * When it gives up, the customer gets 503 "try again shortly". Nothing is half-done: no provider order was created.
 */
@Injectable()
export class ShopClient {
  private readonly logger = new Logger(ShopClient.name);
  readonly breaker: CircuitBreaker;

  constructor(
    @Inject(ENV) private readonly env: PaymentsEnv,
    private readonly metrics: MetricsService,
  ) {
    this.breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 10_000 }, (state) => {
      this.metrics.shopBreaker.set(state === 'open' ? 1 : state === 'half_open' ? 0.5 : 0);
      this.logger.warn(`circuit breaker for the shop is now ${state}`);
    });
  }

  /** The order, or null if the shop says it doesn't exist. Throws 503 when the shop can't answer. */
  async getOrder(orderId: string): Promise<ShopOrder | null> {
    const op = 'get_order';
    try {
      const order = await this.breaker.run(() => this.withRetry(op, () => this.fetchOrder(orderId)));
      this.metrics.shopCalls.inc({ op, result: order ? 'ok' : 'not_found' });
      return order;
    } catch (err) {
      const result = err instanceof CircuitOpenError ? 'open' : (err as Error).name === 'TimeoutError' ? 'timeout' : 'error';
      this.metrics.shopCalls.inc({ op, result });
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'shop_unavailable',
        message: 'payments cannot reach the shop right now; try again shortly',
      });
    }
  }

  private async withRetry<T>(op: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof ShopError && !err.retryable) throw err;
      this.logger.warn(`shop ${op} failed (${(err as Error).message}); retrying once`);
      await sleep(100);
      return call();
    }
  }

  private async fetchOrder(orderId: string): Promise<ShopOrder | null> {
    const stop = this.metrics.shopCallDuration.startTimer({ op: 'get_order' });
    try {
      const res = await fetch(`${this.env.shopUrl}/internal/orders/${encodeURIComponent(orderId)}`, {
        headers: { 'x-service-token': this.env.serviceToken },
        signal: AbortSignal.timeout(this.env.shopTimeoutMs),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new ShopError(`shop answered ${res.status}`, res.status >= 500);
      return (await res.json()) as ShopOrder;
    } finally {
      stop();
    }
  }
}
