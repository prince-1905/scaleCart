import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';
import { RedisService } from './redis.service.js';

/** Wrapper so a cached "doesn't exist" (null) can be told apart from a miss. */
interface Envelope<T> {
  v: T;
}

/** ±10% random TTL, so keys cached at the same moment don't all expire at the same moment. */
const jitter = (seconds: number) => Math.max(1, Math.round(seconds * (0.9 + Math.random() * 0.2)));

/**
 * Cache-aside ("lazy loading"): look in Redis first; on a miss, load from the database
 * and store the result for next time. The database stays the source of truth.
 */
@Injectable()
export class CacheService {
  private readonly enabled: boolean;
  /** Loads in progress in this process, by key. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    @Inject(ENV) env: Env,
  ) {
    this.enabled = env.cacheEnabled;
  }

  /**
   * @param cache     metric label, e.g. "product"
   * @param ttl       seconds a found value stays cached
   * @param missingTtl seconds a `null` ("not found") stays cached: shorter, but it stops
   *                  repeated lookups of ids that don't exist from all reaching MySQL
   */
  async getOrLoad<T>(
    cache: string,
    key: string,
    { ttl, missingTtl }: { ttl: number; missingTtl: number },
    load: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return load();

    const raw = await this.redis.tryRun('get', (r) => r.get(key));
    if (typeof raw === 'string') {
      this.metrics.cacheRequests.inc({ cache, result: 'hit' });
      return (JSON.parse(raw) as Envelope<T>).v;
    }

    // Request coalescing ("single flight"): when a hot key is missing, 500 concurrent
    // requests would otherwise all hit MySQL at once (cache stampede). Only the first
    // loads; the rest wait for its result.
    const pending = this.inflight.get(key);
    if (pending) {
      this.metrics.cacheRequests.inc({ cache, result: 'coalesced' });
      return pending as Promise<T>;
    }
    this.metrics.cacheRequests.inc({ cache, result: raw === null ? 'miss' : 'unavailable' });

    const loading = (async () => {
      const value = await load();
      const seconds = jitter(value === null ? missingTtl : ttl);
      const envelope: Envelope<T> = { v: value };
      await this.redis.tryRun('set', (r) => r.set(key, JSON.stringify(envelope), { EX: seconds }));
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, loading);
    return loading;
  }

  /**
   * Call after the database write. Deleting (not updating) the key means the next read
   * loads the fresh row. A read racing the write can still re-cache the old value; the
   * TTL bounds how long that can last.
   */
  async invalidate(key: string): Promise<void> {
    await this.redis.tryRun('del', (r) => r.del(key));
  }
}
