import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

const CGROUP_CPU_STAT = '/sys/fs/cgroup/cpu.stat';

/** Reads cgroup v2 CPU stats (Linux containers only); null elsewhere. */
function readCgroupCpuStat(): Record<string, number> | null {
  try {
    const text = readFileSync(CGROUP_CPU_STAT, 'utf8');
    return Object.fromEntries(
      text
        .trim()
        .split('\n')
        .map((line) => line.split(' '))
        .map(([key, value]) => [key, Number(value)]),
    );
  } catch {
    return null;
  }
}

/**
 * Owns the Prometheus registry for this process.
 *
 * A per-instance registry (instead of prom-client's global one) keeps tests
 * isolated and makes it impossible to register the same metric twice.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** RED metrics: Rate, Errors and Duration all come from this one histogram. */
  readonly httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP request duration, labelled by route template (never by raw URL).',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [
      0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ],
    registers: [this.registry],
  });

  /** Requests currently being processed. Little's law: inFlight = RPS x latency. */
  readonly httpInFlight = new Gauge({
    name: 'http_server_requests_in_flight',
    help: 'HTTP requests currently being processed by this process.',
    registers: [this.registry],
  });

  /**
   * Argon2id time per call. Hashing runs on libuv's thread pool, not the event loop,
   * so this can grow (pool queueing, CPU limit) while event-loop lag stays flat.
   */
  readonly passwordHashDuration = new Histogram({
    name: 'password_hash_duration_seconds',
    help: 'Time to hash or verify one password with Argon2id, including thread-pool queueing.',
    labelNames: ['op'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  /** Checkout results: created, out_of_stock, replayed, in_progress, ... (see CheckoutService). */
  readonly checkouts = new Counter({
    name: 'checkouts_total',
    help: 'Checkout attempts by outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  /** Cache lookups: hit, miss, coalesced (waited for another request's load), unavailable (Redis down). */
  readonly cacheRequests = new Counter({
    name: 'cache_requests_total',
    help: 'Cache-aside lookups by cache name and result.',
    labelNames: ['cache', 'result'] as const,
    registers: [this.registry],
  });

  /** Redis commands that failed or timed out. The app carries on without Redis (fail open). */
  readonly redisErrors = new Counter({
    name: 'redis_errors_total',
    help: 'Redis commands that failed, timed out, or were skipped because Redis was not connected.',
    labelNames: ['op'] as const,
    registers: [this.registry],
  });

  // ---- Phase 3: messaging (worker process) ----

  readonly rabbitConnected = new Gauge({
    name: 'rabbitmq_connected',
    help: '1 while this process holds a RabbitMQ connection.',
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events published to RabbitMQ (confirmed by the broker).',
    registers: [this.registry],
  });

  /** sent, duplicate (already sent: redelivery), retried, dead_lettered, no_recipient. */
  readonly notifications = new Counter({
    name: 'notifications_total',
    help: 'Order-confirmation messages handled by outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  /** End to end: order committed → email accepted by the mail server. */
  readonly notificationDelay = new Histogram({
    name: 'notification_delay_seconds',
    help: 'Time from order creation to the confirmation email being sent.',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  /** Rows fixed by the worker's cleanup jobs, by job. */
  readonly cleanup = new Counter({
    name: 'cleanup_rows_total',
    help: 'Rows released or deleted by background cleanup jobs.',
    labelNames: ['job'] as const,
    registers: [this.registry],
  });

  // ---- Phase 4 → 8: payments (the payments service itself has its own metrics since the split) ----

  /** Shop side of payments: orders expired, expiry rounds that skipped orders because payments couldn't answer. */
  readonly paymentJobs = new Counter({
    name: 'payment_jobs_total',
    help: 'Work done by the shop worker for payments, by job.',
    labelNames: ['job'] as const,
    registers: [this.registry],
  });

  /** payment.captured events handled by the shop worker: paid, already_paid, paid_by_other, cancelled, retried… */
  readonly paymentEvents = new Counter({
    name: 'shop_payment_events_total',
    help: 'payment.captured events consumed by the shop worker, by result.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /** From the payments service writing payment.captured to the shop settling the order (E11). */
  readonly paymentSettleDelay = new Histogram({
    name: 'shop_payment_settle_delay_seconds',
    help: 'Delay from payment.captured being created to the order being settled by the shop.',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers: [this.registry],
  });

  /** Calls from the shop to the payments service: ok, error, open (refused by the circuit breaker). */
  /** Product searches by who answered (Phase 12): opensearch, mysql (chosen), mysql-fallback (OpenSearch failed). */
  readonly searches = new Counter({
    name: 'product_searches_total',
    help: 'Product searches by the engine that answered them.',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  /** Search index updates by the worker's indexer (Phase 12): indexed, removed, retried, dead_lettered. */
  readonly searchIndexing = new Counter({
    name: 'search_index_updates_total',
    help: 'Product changes applied to the search index, by result.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /** From "product saved in MySQL" (the outbox row) to "searchable in OpenSearch": how far the copy lags. */
  readonly searchIndexLag = new Histogram({
    name: 'search_index_lag_seconds',
    help: 'Time from a product change (outbox event) to its update in the search index.',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [this.registry],
  });

  // Phase 13: read replica.
  readonly replicaLag = new Gauge({
    name: 'mysql_replica_lag_seconds',
    help: 'How far behind the primary the read replica is (heartbeat age, checked every second).',
    registers: [this.registry],
  });

  readonly replicaState = new Gauge({
    name: 'mysql_replica_state',
    help: '1 for the read replica\'s current state: off, starting, ok, lagging (too far behind), down.',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  readonly dbReads = new Counter({
    name: 'db_routed_reads_total',
    help: 'Reads that could use the replica, by where they went and why.',
    labelNames: ['module', 'target', 'reason'] as const,
    registers: [this.registry],
  });

  readonly readYourWritesWait = new Histogram({
    name: 'replica_read_your_writes_wait_seconds',
    help: "Time spent waiting for the replica to have a customer's own recent write.",
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
    registers: [this.registry],
  });

  /** Calls to the identity service (Phase 11): users' emails. ok, error (after the retry), timeout, open (breaker). */
  readonly identityCalls = new Counter({
    name: 'identity_service_calls_total',
    help: 'Calls from the shop to the identity service, by operation and result.',
    labelNames: ['op', 'result'] as const,
    registers: [this.registry],
  });

  readonly identityBreaker = new Gauge({
    name: 'identity_circuit_breaker_state',
    help: 'Circuit breaker for calls to the identity service: 0 closed, 0.5 half-open, 1 open.',
    registers: [this.registry],
  });

  readonly paymentsCalls = new Counter({
    name: 'payments_service_calls_total',
    help: 'Calls from the shop to the payments service, by operation and result.',
    labelNames: ['op', 'result'] as const,
    registers: [this.registry],
  });

  readonly paymentsBreaker = new Gauge({
    name: 'payments_circuit_breaker_state',
    help: 'Circuit breaker for calls to the payments service: 0 closed, 0.5 half-open, 1 open.',
    registers: [this.registry],
  });

  // ---- Phase 4.5: drops and the waiting room ----

  /** Queue calls by result: waiting, admitted (a pass was issued), unavailable (Redis down). */
  readonly dropQueue = new Counter({
    name: 'drop_queue_requests_total',
    help: 'Waiting-room calls by result.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /** Drop checkouts refused before any stock was touched: drop_not_started, drop_pass_required, drop_limit, drop_already_bought. */
  readonly dropCheckoutRejections = new Counter({
    name: 'drop_checkout_rejections_total',
    help: 'Checkouts of drop products refused by the drop rules, by reason.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  /** The Redis door counter: taken (may try MySQL), sold_out (answered without MySQL), unavailable (Redis down: straight to MySQL). */
  readonly dropStockGate = new Counter({
    name: 'drop_stock_gate_total',
    help: 'Drop checkouts by what the Redis stock counter answered.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /** API-wide rate limit: allowed or limited (429); source = redis (shared) or local (Redis too slow/down: this pod's own bucket). */
  readonly rateLimit = new Counter({
    name: 'rate_limit_total',
    help: 'Requests checked by the API-wide token bucket, by policy, result and which bucket decided.',
    labelNames: ['policy', 'result', 'source'] as const,
    registers: [this.registry],
  });

  /** Two-factor login: enabled, disabled, code_ok, backup_code_ok, wrong_code, locked. */
  readonly twoFactor = new Counter({
    name: 'auth_two_factor_total',
    help: 'Two-factor (authenticator app) events by result.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor() {
    // CPU, memory, heap, GC pauses and event-loop delay (p50/p90/p99, via perf_hooks).
    collectDefaultMetrics({
      register: this.registry,
      eventLoopMonitoringPrecision: 10,
    });

    // Event-loop utilization: the fraction of time the single JS thread was busy
    // since the previous scrape. ~1.0 means this process is CPU-saturated even
    // if the container still has spare cores.
    let last = performance.eventLoopUtilization();
    new Gauge({
      name: 'nodejs_eventloop_utilization_ratio',
      help: 'Fraction of time the event loop was active since the last scrape (0..1).',
      registers: [this.registry],
      collect() {
        const now = performance.eventLoopUtilization();
        this.set(performance.eventLoopUtilization(now, last).utilization);
        last = now;
      },
    });

    // CPU throttling: time the kernel paused this container because it used up its
    // CPU quota (the Docker/Kubernetes CPU *limit*). Throttling shows up as latency
    // spikes, not as "slower CPU", which is why it deserves its own metric.
    if (readCgroupCpuStat()) {
      new Counter({
        name: 'container_cpu_throttled_seconds_total',
        help: 'Total time this container was throttled by its CPU limit (cgroup cpu.stat).',
        registers: [this.registry],
        collect() {
          const stat = readCgroupCpuStat();
          if (!stat) return;
          this.reset();
          this.inc((stat.throttled_usec ?? 0) / 1e6);
        },
      });
      new Counter({
        name: 'container_cpu_throttled_periods_total',
        help: 'Number of scheduler periods in which this container was throttled.',
        registers: [this.registry],
        collect() {
          const stat = readCgroupCpuStat();
          if (!stat) return;
          this.reset();
          this.inc(stat.nr_throttled ?? 0);
        },
      });
    }
  }
}
