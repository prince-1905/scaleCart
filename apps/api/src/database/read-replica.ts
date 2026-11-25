import { Global, Inject, Injectable, Logger, Module, ServiceUnavailableException, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { RedisService } from '../cache/redis.service.js';
import { catalogDatabase } from '../catalog/catalog.database.js';
import { ENV, type Env } from '../config/env.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { MetricsService } from '../observability/metrics.service.js';
import { ordersDatabase } from '../orders/orders.database.js';
import { mysqlOptions } from './database.js';

/** Modules whose browsing reads may use the replica. */
export type ReplicaModule = 'catalog' | 'orders';
export type ReplicaState = 'off' | 'starting' | 'ok' | 'lagging' | 'down';

const STATES: ReplicaState[] = ['off', 'starting', 'ok', 'lagging', 'down'];
const CHECK_EVERY_MS = 1_000;

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, sleep(ms, undefined, { ref: false }).then(() => Promise.reject(new Error(`${what}: no answer in ${ms} ms`)))]);

/**
 * Phase 13: where a read goes. The read replica is a copy of the primary that is a little behind (async
 * replication), so only reads that may be a moment old use it: product lists and pages, order history, the admin
 * dashboard. Writes, cart, checkout and prices never come here.
 *
 * Like a photocopy of the ledger at the front desk: browsing customers read the copy, the cashier uses the original.
 *
 * - Every second it reads the heartbeat (stamped on the primary by the worker every 250 ms) from the replica:
 *   "now minus the stamp" = how far behind it is. Down, or more than READ_REPLICA_MAX_LAG_SECONDS behind → reads go to
 *   the primary until it catches up. A read that fails on the replica is retried once on the primary.
 * - Read-your-writes: after a customer's own write (checkout), the primary's executed-transactions set (GTIDs) is
 *   remembered for that customer for a few seconds. Their next order reads ask the replica to WAIT until it has those
 *   transactions (at most READ_YOUR_WRITES_WAIT_MS), else read the primary. So "My orders" never misses an order
 *   they just placed.
 */
@Injectable()
export class ReadReplica implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReadReplica.name);
  private readonly sources = new Map<ReplicaModule, DataSource>();
  private readonly initializing = new Map<ReplicaModule, Promise<DataSource>>();
  private state: ReplicaState;
  private lag: number | null = null;
  private timer?: NodeJS.Timeout;
  private checking = false;
  private fallbackInFlight = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {
    const replica = env.db.replica;
    this.state = replica ? 'starting' : 'off';
    if (replica) {
      for (const def of [catalogDatabase, ordersDatabase]) {
        this.sources.set(
          def.module as ReplicaModule,
          new DataSource({
            ...mysqlOptions(env.db, def, replica.poolSize),
            host: replica.host,
            port: replica.port,
            migrations: [],
            connectTimeout: 2_000,
          } as DataSourceOptions),
        );
      }
    }
    this.publishState();
  }

  get current(): { state: ReplicaState; lagSeconds: number | null } {
    return { state: this.state, lagSeconds: this.lag };
  }

  onModuleInit() {
    if (this.state === 'off') return;
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await Promise.all([...this.sources.values()].filter((ds) => ds.isInitialized).map((ds) => ds.destroy().catch(() => {})));
  }

  /** A read that may be a moment old: on the replica when it's healthy, else on the primary. */
  async read<T>(module: ReplicaModule, primary: DataSource, run: (db: DataSource) => Promise<T>): Promise<T> {
    const replica = this.state === 'ok' ? this.sources.get(module) : undefined;
    return this.runOn(module, replica, primary, run, replica ? 'healthy' : this.state);
  }

  /** A read of the customer's OWN data: also waits until the replica has their recent writes (else the primary). */
  async readForUser<T>(module: ReplicaModule, primary: DataSource, userId: string, run: (db: DataSource) => Promise<T>): Promise<T> {
    const replica = this.state === 'ok' ? this.sources.get(module) : undefined;
    if (!replica) return this.runOn(module, undefined, primary, run, this.state);
    if (!this.env.db.replica!.readYourWrites) return this.runOn(module, replica, primary, run, 'healthy');
    const gtids = await this.redis.tryRun('get', (r) => r.get(writeKey(userId)));
    // undefined = Redis unavailable: we can't know about a recent write, so play safe.
    if (gtids === undefined) return this.runOn(module, undefined, primary, run, 'ryw_unknown');
    if (gtids === null) return this.runOn(module, replica, primary, run, 'healthy');
    const caughtUp = await this.waitFor(replica, gtids);
    return this.runOn(module, caughtUp ? replica : undefined, primary, run, caughtUp ? 'ryw_caught_up' : 'ryw_not_yet');
  }

  /** Call after a customer's write commits on the primary: their next own reads must see it. */
  async rememberWrite(userId: string, primary: DataSource): Promise<void> {
    const replica = this.env.db.replica;
    if (!replica?.readYourWrites) return;
    const [row] = (await primary.query('SELECT @@GLOBAL.gtid_executed AS gtids')) as { gtids: string }[];
    await this.redis.tryRun('set', (r) => r.set(writeKey(userId), row.gtids, { PX: replica.readYourWritesTtlMs }));
  }

  private async waitFor(replica: DataSource, gtids: string): Promise<boolean> {
    const started = performance.now();
    try {
      const seconds = this.env.db.replica!.readYourWritesWaitMs / 1000;
      const [row] = (await replica.query('SELECT WAIT_FOR_EXECUTED_GTID_SET(?, ?) AS timedOut', [gtids, seconds])) as { timedOut: number | string }[];
      return Number(row.timedOut) === 0;
    } catch {
      return false;
    } finally {
      this.metrics.readYourWritesWait.observe((performance.now() - started) / 1000);
    }
  }

  private async runOn<T>(
    module: ReplicaModule,
    replica: DataSource | undefined,
    primary: DataSource,
    run: (db: DataSource) => Promise<T>,
    reason: string,
  ): Promise<T> {
    if (replica) {
      try {
        const result = await run(replica);
        this.metrics.dbReads.inc({ module, target: 'replica', reason });
        return result;
      } catch (err) {
        // Reads are safe to repeat: answer from the primary, and let the next check decide about the replica.
        this.logger.warn(`read on the replica failed, using the primary: ${(err as Error).message}`);
        this.setState('down');
        reason = 'replica_failed';
      }
    }
    // No replica configured: the primary is the normal place for every read, nothing to limit.
    if (this.state === 'off') {
      const result = await run(primary);
      this.metrics.dbReads.inc({ module, target: 'primary', reason });
      return result;
    }
    // Bulkhead (E16a): reads meant for the replica may fall back to the primary, but only a few at once. Without it an
    // overloaded replica looked "down" and ALL its reads (dashboard scans included) landed on the primary, and
    // checkout slowed down with it. A customer's own reads right after their write also pass through here.
    if (this.fallbackInFlight >= this.env.db.replica!.fallbackConcurrency) {
      this.metrics.dbReads.inc({ module, target: 'refused', reason });
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'read_busy',
        message: 'this page is busy right now; try again in a moment',
      });
    }
    this.fallbackInFlight++;
    try {
      const result = await run(primary);
      this.metrics.dbReads.inc({ module, target: 'primary', reason });
      return result;
    } finally {
      this.fallbackInFlight--;
    }
  }

  private async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const module of this.sources.keys()) await this.ready(module);
      const rows = (await withTimeout(
        this.sources.get('orders')!.query(
          'SELECT TIMESTAMPDIFF(MICROSECOND, beat_at, UTC_TIMESTAMP(6)) / 1000000 AS lagSeconds FROM replication_heartbeat WHERE id = 1',
        ),
        1_000,
        'heartbeat read',
      )) as { lagSeconds: string | number }[];
      this.lag = rows[0] ? Math.max(0, Number(rows[0].lagSeconds)) : null;
      if (this.lag !== null) this.metrics.replicaLag.set(this.lag);
      // No heartbeat yet (worker not running) counts as "lagging": we can't tell how fresh the copy is.
      this.setState(this.lag !== null && this.lag <= this.env.db.replica!.maxLagSeconds ? 'ok' : 'lagging');
    } catch (err) {
      this.lag = null;
      if (this.state !== 'down') this.logger.warn(`read replica unavailable: ${(err as Error).message}`);
      this.setState('down');
    } finally {
      this.checking = false;
    }
  }

  /** Connects a replica pool on first use; a replica that is down at start never blocks the API. */
  private async ready(module: ReplicaModule): Promise<DataSource> {
    const ds = this.sources.get(module)!;
    if (ds.isInitialized) return ds;
    let pending = this.initializing.get(module);
    if (!pending) {
      pending = ds.initialize().finally(() => this.initializing.delete(module));
      this.initializing.set(module, pending);
    }
    return withTimeout(pending, 3_000, `connect to the replica (${module})`);
  }

  private setState(state: ReplicaState) {
    if (state === this.state) return;
    this.logger.log(`read replica: ${this.state} → ${state}${this.lag !== null ? ` (lag ${this.lag.toFixed(3)} s)` : ''}`);
    this.state = state;
    this.publishState();
  }

  private publishState() {
    for (const s of STATES) this.metrics.replicaState.set({ state: s }, s === this.state ? 1 : 0);
  }
}

const writeKey = (userId: string) => `ryw:${userId}`;

/** Global: OrdersService (also used by the worker) and the catalog read through it. Off unless DB_READ_HOST is set. */
@Global()
@Module({
  imports: [CacheModule, ObservabilityModule],
  providers: [ReadReplica],
  exports: [ReadReplica],
})
export class ReadReplicaModule {}
