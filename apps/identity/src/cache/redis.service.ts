import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { createClient } from 'redis';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';

/** A slow Redis must not make the app slow: give up and fall back after this long. */
const COMMAND_TIMEOUT_MS = 200;

export type Redis = ReturnType<typeof createClient>;

/**
 * One Redis connection per process, used as an *optional* speed-up.
 *
 * Fail open: when Redis is down or slow, commands return `undefined` and callers fall
 * back (cache miss → MySQL, rate limit → allow). Redis is never on the critical path
 * for correctness: stock, orders and idempotency keys all live in MySQL.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private lastErrorLog = 0;

  constructor(
    @Inject(ENV) env: Env,
    private readonly metrics: MetricsService,
  ) {
    this.client = createClient({
      url: env.redisUrl,
      // While disconnected, fail commands immediately instead of queueing them.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5_000),
      },
    });
    // Without a listener, a connection error would crash the process.
    this.client.on('error', (err) => {
      if (Date.now() - this.lastErrorLog > 10_000) {
        this.lastErrorLog = Date.now();
        this.logger.warn(`redis unavailable, continuing without it: ${(err as Error).message}`);
      }
    });
  }

  onModuleInit() {
    // Not awaited: the API starts (and serves from MySQL) even if Redis is down.
    this.client.connect().catch(() => {});
  }

  async onApplicationShutdown() {
    if (this.client.isReady) await this.client.close().catch(() => {});
    else this.client.destroy();
  }

  get isReady(): boolean {
    return this.client.isReady;
  }

  /** Runs a command, or returns undefined if Redis is unavailable, errors, or is too slow. */
  async tryRun<T>(op: string, command: (redis: Redis) => Promise<T>): Promise<T | undefined> {
    if (!this.client.isReady) {
      this.metrics.redisErrors.inc({ op });
      return undefined;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        command(this.client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`redis ${op} timed out`)), COMMAND_TIMEOUT_MS);
        }),
      ]);
    } catch {
      this.metrics.redisErrors.inc({ op });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
