import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '../cache/redis.service.js';
import { ENV, type Env } from '../config/env.js';

/**
 * Limits failed logins per email: after N failures within the window, the account's
 * login is refused with 429 until the window ends.
 *
 * - Stops online password guessing against one account.
 * - Refused attempts skip Argon2 entirely: each blocked guess costs ~0 CPU instead of
 *   ~30 ms (E1 measured ~22 logins/s per CPU, so guessing floods are a CPU attack too).
 * - Counter lives in Redis, so every API replica sees the same count.
 * - Fails open: if Redis is down, logins are allowed (availability over strictness).
 *
 * Per-IP limits (many accounts from one address) need the real client IP from the load
 * balancer's X-Forwarded-For header: a later step.
 */
@Injectable()
export class LoginThrottle {
  private readonly max: number;
  private readonly windowSeconds: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) env: Env,
  ) {
    this.max = env.loginMaxFailures;
    this.windowSeconds = env.loginFailureWindowSeconds;
  }

  async assertAllowed(email: string): Promise<void> {
    const key = this.key(email);
    const failures = await this.redis.tryRun('get', (r) => r.get(key));
    if (failures && Number(failures) >= this.max) {
      const ttl = (await this.redis.tryRun('ttl', (r) => r.ttl(key))) ?? this.windowSeconds;
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'too_many_failed_logins',
          message: 'too many failed logins for this account; try again later',
          retryAfterSeconds: Math.max(ttl, 1),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Counts a failure. The window starts at the first failure (fixed window). */
  async recordFailure(email: string): Promise<void> {
    const key = this.key(email);
    await this.redis.tryRun('incr', (r) =>
      r.multi().incr(key).expire(key, this.windowSeconds, 'NX').exec(),
    );
  }

  async reset(email: string): Promise<void> {
    await this.redis.tryRun('del', (r) => r.del(this.key(email)));
  }

  /** Hashed, so Redis never holds email addresses. */
  private key(email: string) {
    return `identity:login-failures:${createHash('sha256').update(email).digest('hex')}`;
  }
}
