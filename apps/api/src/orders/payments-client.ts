import { Inject, Injectable, Logger } from '@nestjs/common';
import { CircuitBreaker } from '../common/circuit-breaker.js';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';

/**
 * The shop's one synchronous call to the payments service (Phase 8), from the expiry job: "order X is overdue, was it
 * paid after all?" (payments asks Razorpay, in case a webhook was lost). Timeout per call, and a circuit breaker:
 * when payments keeps failing, the job stops waiting on it and simply leaves those orders for a later round.
 */
@Injectable()
export class PaymentsClient {
  private readonly logger = new Logger(PaymentsClient.name);
  readonly breaker: CircuitBreaker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: MetricsService,
  ) {
    this.breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 30_000 }, (state) => {
      this.metrics.paymentsBreaker.set(state === 'open' ? 1 : state === 'half_open' ? 0.5 : 0);
      this.logger.warn(`circuit breaker for the payments service is now ${state}`);
    });
  }

  /** true = keep the order (paid, the event is on its way); false = really unpaid. Throws when it couldn't be checked. */
  async paidAfterAll(orderId: string): Promise<boolean> {
    try {
      const answer = await this.breaker.run(async () => {
        const res = await fetch(`${this.env.paymentsUrl}/internal/orders/${orderId}/reconcile`, {
          method: 'POST',
          headers: { 'x-service-token': this.env.internalServiceToken },
          signal: AbortSignal.timeout(this.env.paymentsTimeoutMs),
        });
        if (!res.ok) throw new Error(`payments answered ${res.status}`);
        return (await res.json()) as { paid: boolean };
      });
      this.metrics.paymentsCalls.inc({ op: 'reconcile', result: 'ok' });
      return answer.paid;
    } catch (err) {
      this.metrics.paymentsCalls.inc({ op: 'reconcile', result: this.breaker.current === 'open' ? 'open' : 'error' });
      throw err;
    }
  }
}
