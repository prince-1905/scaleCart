import { Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { CircuitBreaker } from '../common/circuit-breaker.js';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';

/**
 * The one thing the shop needs from the identity service (Phase 11): users' email addresses (confirmation emails,
 * the admin's order list and order page). Before the split this was a query on the identity database; now it is
 * `GET {IDENTITY_URL}/internal/users?ids=…` with the service token, so the shop never touches identity's data.
 *
 * Every call: a timeout (IDENTITY_TIMEOUT_MS), one retry after 100 ms, and a circuit breaker (5 failures in a row →
 * stop calling for 10 s). Callers decide what "identity is down" means: the email consumer retries later through
 * the queue (late, never lost), the admin list shows the orders without addresses.
 */
@Injectable()
export class UserDirectory {
  private readonly logger = new Logger(UserDirectory.name);
  readonly breaker: CircuitBreaker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: MetricsService,
  ) {
    this.breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 10_000 }, (state) => {
      this.metrics.identityBreaker.set(state === 'open' ? 1 : state === 'half_open' ? 0.5 : 0);
      this.logger.warn(`circuit breaker for the identity service is now ${state}`);
    });
  }

  /** null = no such user. Throws when identity can't answer. */
  async getEmail(userId: string): Promise<string | null> {
    return (await this.getEmails([userId])).get(userId) ?? null;
  }

  /** Emails for a page of users at once (admin order list): one call, not one per row. Throws when identity can't answer. */
  async getEmails(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    try {
      const users = await this.breaker.run(() => this.withRetry(() => this.fetchUsers(ids)));
      this.metrics.identityCalls.inc({ op: 'users', result: 'ok' });
      return new Map(users.map((u) => [u.id, u.email]));
    } catch (err) {
      this.metrics.identityCalls.inc({
        op: 'users',
        result: this.breaker.current === 'open' ? 'open' : (err as Error).name === 'TimeoutError' ? 'timeout' : 'error',
      });
      throw err;
    }
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch {
      await sleep(100);
      return call();
    }
  }

  private async fetchUsers(ids: string[]): Promise<{ id: string; email: string }[]> {
    const res = await fetch(`${this.env.identityUrl}/internal/users?ids=${ids.map(encodeURIComponent).join(',')}`, {
      headers: { 'x-service-token': this.env.internalServiceToken },
      signal: AbortSignal.timeout(this.env.identityTimeoutMs),
    });
    if (!res.ok) throw new Error(`identity answered ${res.status}`);
    return ((await res.json()) as { users: { id: string; email: string }[] }).users;
  }
}
