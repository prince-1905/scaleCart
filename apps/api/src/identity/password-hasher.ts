import { Injectable, Optional } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { MetricsService } from '../observability/metrics.service.js';

/**
 * OWASP Password Storage Cheat Sheet minimum for Argon2id: 19 MiB memory,
 * 2 iterations, 1 lane. Memory-hard on purpose, so GPU guessing is expensive.
 * It is also expensive for us: this is the most CPU-heavy thing the API does.
 */
export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The argon2 native addon runs on libuv's thread pool (4 threads by default), so the
 * event loop stays free, but those threads still share the container's CPU quota.
 */
@Injectable()
export class PasswordHasher {
  private dummyHash?: Promise<string>;

  constructor(@Optional() private readonly metrics?: MetricsService) {}

  async hash(password: string): Promise<string> {
    const stop = this.metrics?.passwordHashDuration.startTimer({ op: 'hash' });
    try {
      return await hash(password, ARGON2_OPTIONS);
    } finally {
      stop?.();
    }
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    const stop = this.metrics?.passwordHashDuration.startTimer({ op: 'verify' });
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    } finally {
      stop?.();
    }
  }

  /**
   * Does the same work as a real check, for emails that don't exist. Otherwise
   * "unknown email" would answer ~20x faster than "wrong password", and the
   * response time alone would tell an attacker which emails have accounts.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= hash('not-a-real-password', ARGON2_OPTIONS);
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
