/**
 * Typed, validated environment configuration.
 *
 * Read once at startup (before Nest boots) because some values — like which
 * HTTP adapter to use — must be known before the application is created.
 */
export type HttpAdapterName = 'fastify' | 'express';

/**
 * How checkout takes stock. Only `atomic` is correct and fast; the other two exist
 * so experiment E1 can measure what goes wrong without it (lab mode only).
 *   atomic   UPDATE ... SET available = available - n WHERE available >= n
 *   locking  SELECT ... FOR UPDATE, check in Node, then UPDATE (correct, holds the lock longer)
 *   naive    SELECT, check in Node, then UPDATE with the computed value (oversells)
 */
export type StockReservationStrategy = 'atomic' | 'locking' | 'naive';

/**
 * How the order-confirmation email is sent.
 *   outbox  checkout writes an event row in the same transaction; a worker publishes it
 *           to RabbitMQ and another sends the email (the API never waits for email)
 *   sync    checkout sends the email itself before answering (lab only, for experiment E3)
 */
export type NotifyMode = 'outbox' | 'sync';
/** Where product search runs (Phase 12): the OpenSearch copy (default), or MySQL FULLTEXT (experiment E15, fallback). */
export type SearchEngine = 'opensearch' | 'mysql';

import type { RateLimitPolicy } from '../rate-limit/rate-limit.js';
import type { BucketSize } from '../rate-limit/token-bucket.js';

export type AiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/** api = the HTTP server; worker = background process (outbox relay, consumers, cleanup jobs). */
export type ProcessRole = 'api' | 'worker';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Every module's database is `<prefix><module>`, e.g. scalecart_catalog. Tests use another prefix. */
  databasePrefix: string;
  /** Connections per module pool. Total per process = poolSize x number of modules. */
  poolSize: number;
  /** Phase 13: the read replica, or null: every read goes to the primary. */
  replica: ReplicaConfig | null;
}

export interface ReplicaConfig {
  host: string;
  port: number;
  /** Connections per module pool on the replica (only the modules that read from it). */
  poolSize: number;
  /** Further behind than this (or no heartbeat) → reads go to the primary until it catches up. */
  maxLagSeconds: number;
  /** Replica down or behind: at most this many of its reads run on the primary at once; more get 503 (E16a). */
  fallbackConcurrency: number;
  /** Off only for E16: a customer's own reads then use the replica like any other read (the stale-read bug). */
  readYourWrites: boolean;
  /** After a customer's own write: wait at most this long for the replica to have it, else read the primary. */
  readYourWritesWaitMs: number;
  /** How long a customer's write is remembered for that check. */
  readYourWritesTtlMs: number;
}

export interface Env {
  port: number;
  httpAdapter: HttpAdapterName;
  logLevel: string;
  /** Per-request access logs. Disable during load tests: logging every request costs real CPU. */
  httpAccessLog: boolean;
  /** Exposes /lab/* endpoints used for performance experiments. Never enable in production. */
  labEndpoints: boolean;
  serviceName: string;
  db: DbConfig;
  /**
   * Since Phase 11 NOT for login tokens (identity signs those with its private key; the shop checks them with the
   * public keys). Only the shop's own HMACs: the drop "pass" of the waiting room.
   */
  jwtSecret: string;
  /** The identity service inside the network (Phase 11): its public keys (JWKS) and users' emails. */
  identityUrl: string;
  identityTimeoutMs: number;
  /**
   * Phase 12: product search reads a copy of the catalog in OpenSearch (the CQRS read model), kept in sync by
   * product.changed events. MySQL stays the truth; when OpenSearch can't answer, search falls back to MySQL.
   */
  searchEngine: SearchEngine;
  openSearchUrl: string;
  /** The alias searches go to; a re-index builds a new index behind it and switches the alias (no downtime). */
  searchIndex: string;
  searchTimeoutMs: number;
  /** At most this many searches fall back to MySQL at the same time (a bulkhead, E15b); the rest get 503. */
  searchFallbackConcurrency: number;
  stockReservation: StockReservationStrategy;
  /**
   * Size of the kernel queue for connections not yet accepted by Node. Node's default
   * is 511; a 2,000-request burst overflowed it (experiment E2). The kernel caps it
   * at net.core.somaxconn.
   */
  listenBacklog: number;
  redisUrl: string;
  /** Cache-aside for public product reads. Off = every read goes to MySQL (for experiments). */
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
  /** Serves the Swagger UI at /docs and the OpenAPI document at /docs-json. */
  apiDocs: boolean;
  role: ProcessRole;
  notifyMode: NotifyMode;
  rabbitmqUrl: string;
  /** Prefix for exchange and queue names, so e2e tests never share queues with the dev stack. */
  mqPrefix: string;
  smtpHost: string;
  smtpPort: number;
  mailFrom: string;
  /** How often the worker's cleanup jobs run. */
  cleanupIntervalSeconds: number;
  /** Empty = AI features are off (the /ai routes answer 503). Never sent to the browser. */
  geminiApiKey: string;
  aiModel: string;
  /** How much the model thinks before answering. minimal ≈ 1 s faster per call than low (E3.5). */
  aiThinkingLevel: AiThinkingLevel;
  /** Per model call. The SDK retries 429/5xx itself, so one chat message can take longer. */
  aiTimeoutMs: number;
  /** Chat messages per user per minute: each one costs model calls (and free-tier quota). */
  aiChatPerMinute: number;
  /** An unpaid order is cancelled and its stock released after this long (the shop owns this deadline). */
  paymentTimeoutSeconds: number;
  /** How often the worker expires overdue orders. */
  paymentJobsIntervalSeconds: number;
  /**
   * Phase 8: payments is its own service. The shared token for calls between the two (X-Service-Token);
   * empty = /internal/* routes refuse everything.
   */
  internalServiceToken: string;
  /** The payments service inside the network (never through NGINX), for the expiry job's "paid after all?" check. */
  paymentsUrl: string;
  paymentsTimeoutMs: number;
  /** A Redis "door counter" in front of each drop's MySQL stock row. Off = every buyer goes to MySQL (experiment E6). */
  dropStockGate: boolean;
  /** How often each API replica resets the drop counters from MySQL. */
  dropStockGateResetSeconds: number;
  /** On SIGTERM, keep serving this long with "Connection: close" before closing (graceful drain, E7a). */
  shutdownDrainSeconds: number;
  /** Close a keep-alive connection after this many requests, so load spreads to new pods (E7b). 0 = no limit. */
  httpMaxRequestsPerSocket: number;
  /** API-wide token-bucket rate limit (Redis). Off for load tests that send everything from one IP. */
  rateLimitEnabled: boolean;
  /** Bucket size per policy, from RATE_LIMIT_<POLICY>="capacity:refillPerSecond". */
  rateLimits: Record<RateLimitPolicy, BucketSize>;
  /** Behind NGINX: take the client IP from X-Real-IP. Never enable without a proxy that sets it. */
  trustProxy: boolean;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function positiveInt(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function nonNegativeInt(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

/** "capacity:refillPerSecond", e.g. "10:0.2" = bursts of 10, then one every 5 s. */
function bucketSize(source: NodeJS.ProcessEnv, name: string, fallback: string): BucketSize {
  const raw = source[name] || fallback;
  const [capacity, refillPerSecond] = raw.split(':').map(Number);
  if (!Number.isInteger(capacity) || capacity <= 0 || !(refillPerSecond > 0)) {
    throw new Error(`Invalid ${name}: ${raw} (expected capacity:refillPerSecond, e.g. 10:0.2)`);
  }
  return { capacity, refillPerSecond };
}

/** Database settings only, so one-off jobs (migrate, seed) don't need the API's secrets. */
export function loadDbConfig(source: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: source.DB_HOST ?? '127.0.0.1',
    port: positiveInt(source, 'DB_PORT', 3307),
    user: source.DB_USER ?? 'scalecart',
    password: source.DB_PASSWORD ?? '',
    databasePrefix: source.DB_PREFIX ?? 'scalecart_',
    poolSize: positiveInt(source, 'DB_POOL_SIZE', 5),
    // DB_READ_HOST set = use the replica; READ_REPLICA=off sends every read to the primary (E16 comparisons).
    replica:
      source.DB_READ_HOST && source.READ_REPLICA !== 'off'
        ? {
            host: source.DB_READ_HOST,
            port: positiveInt(source, 'DB_READ_PORT', 3306),
            poolSize: positiveInt(source, 'DB_READ_POOL_SIZE', positiveInt(source, 'DB_POOL_SIZE', 5)),
            maxLagSeconds: positiveInt(source, 'READ_REPLICA_MAX_LAG_SECONDS', 2),
            fallbackConcurrency: positiveInt(source, 'READ_FALLBACK_CONCURRENCY', 4),
            readYourWrites: source.READ_YOUR_WRITES !== 'off',
            readYourWritesWaitMs: nonNegativeInt(source, 'READ_YOUR_WRITES_WAIT_MS', 50),
            readYourWritesTtlMs: positiveInt(source, 'READ_YOUR_WRITES_TTL_MS', 10_000),
          }
        : null,
  };
}

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  role: ProcessRole = 'api',
): Env {
  const port = positiveInt(source, 'PORT', role === 'api' ? 3000 : 3001);

  const httpAdapter = (source.HTTP_ADAPTER ?? 'fastify').toLowerCase();
  if (httpAdapter !== 'fastify' && httpAdapter !== 'express') {
    throw new Error(`Invalid HTTP_ADAPTER: ${source.HTTP_ADAPTER} (expected fastify|express)`);
  }

  // No default: a guessable signing key would let anyone mint access tokens.
  // The worker never signs or checks tokens, so it doesn't get the secret at all.
  const jwtSecret = source.JWT_SECRET ?? '';
  if (role === 'api' && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters long');
  }

  const labEndpoints = bool(source.LAB_ENDPOINTS, false);
  const searchEngine = (source.SEARCH_ENGINE ?? 'opensearch').toLowerCase();
  if (searchEngine !== 'opensearch' && searchEngine !== 'mysql') {
    throw new Error(`Invalid SEARCH_ENGINE: ${source.SEARCH_ENGINE} (expected opensearch|mysql)`);
  }
  const searchIndex = source.SEARCH_INDEX ?? 'products';
  if (!/^[a-z0-9_-]+$/.test(searchIndex)) throw new Error(`Invalid SEARCH_INDEX: ${searchIndex}`);
  const notifyMode = (source.NOTIFY_MODE ?? 'outbox').toLowerCase();
  if (notifyMode !== 'outbox' && notifyMode !== 'sync') {
    throw new Error(`Invalid NOTIFY_MODE: ${source.NOTIFY_MODE} (expected outbox|sync)`);
  }
  if (notifyMode === 'sync' && !labEndpoints) {
    throw new Error('NOTIFY_MODE=sync is only allowed with LAB_ENDPOINTS=true');
  }
  const stockReservation = (source.STOCK_RESERVATION ?? 'atomic').toLowerCase();
  if (stockReservation !== 'atomic' && stockReservation !== 'locking' && stockReservation !== 'naive') {
    throw new Error(
      `Invalid STOCK_RESERVATION: ${source.STOCK_RESERVATION} (expected atomic|locking|naive)`,
    );
  }
  if (stockReservation !== 'atomic' && !labEndpoints) {
    throw new Error('STOCK_RESERVATION other than atomic is only allowed with LAB_ENDPOINTS=true');
  }

  const aiThinkingLevel = (source.AI_THINKING_LEVEL ?? 'minimal').toLowerCase();
  if (!['minimal', 'low', 'medium', 'high'].includes(aiThinkingLevel)) {
    throw new Error(
      `Invalid AI_THINKING_LEVEL: ${source.AI_THINKING_LEVEL} (expected minimal|low|medium|high)`,
    );
  }

  return {
    port,
    httpAdapter,
    logLevel: source.LOG_LEVEL ?? 'info',
    httpAccessLog: bool(source.HTTP_ACCESS_LOG, true),
    labEndpoints,
    serviceName: source.SERVICE_NAME ?? `scalecart-${role}`,
    db: loadDbConfig(source),
    jwtSecret,
    identityUrl: (source.IDENTITY_URL ?? 'http://127.0.0.1:3003').replace(/\/$/, ''),
    identityTimeoutMs: positiveInt(source, 'IDENTITY_TIMEOUT_MS', 1_000),
    searchEngine,
    openSearchUrl: (source.OPENSEARCH_URL ?? 'http://127.0.0.1:9200').replace(/\/+$/, ''),
    searchIndex,
    searchTimeoutMs: positiveInt(source, 'SEARCH_TIMEOUT_MS', 1_000),
    searchFallbackConcurrency: positiveInt(source, 'SEARCH_FALLBACK_CONCURRENCY', 4),
    stockReservation,
    listenBacklog: positiveInt(source, 'HTTP_LISTEN_BACKLOG', 4096),
    redisUrl: source.REDIS_URL ?? 'redis://127.0.0.1:6379',
    cacheEnabled: bool(source.CACHE_ENABLED, true),
    cacheTtlSeconds: positiveInt(source, 'CACHE_TTL_SECONDS', 60),
    apiDocs: bool(source.API_DOCS, true),
    role,
    notifyMode,
    rabbitmqUrl: source.RABBITMQ_URL ?? 'amqp://scalecart:scalecart@127.0.0.1:5672',
    mqPrefix: source.MQ_PREFIX ?? '',
    smtpHost: source.SMTP_HOST ?? '127.0.0.1',
    smtpPort: positiveInt(source, 'SMTP_PORT', 1025),
    mailFrom: source.MAIL_FROM ?? 'ScaleCart <orders@scalecart.local>',
    cleanupIntervalSeconds: positiveInt(source, 'CLEANUP_INTERVAL_SECONDS', 60),
    geminiApiKey: source.GEMINI_API_KEY ?? '',
    aiModel: source.AI_MODEL ?? 'gemini-3.6-flash',
    aiThinkingLevel: aiThinkingLevel as AiThinkingLevel,
    aiTimeoutMs: positiveInt(source, 'AI_TIMEOUT_MS', 30_000),
    aiChatPerMinute: positiveInt(source, 'AI_CHAT_PER_MINUTE', 10),
    paymentTimeoutSeconds: positiveInt(source, 'PAYMENT_TIMEOUT_SECONDS', 900),
    paymentJobsIntervalSeconds: positiveInt(source, 'PAYMENT_JOBS_INTERVAL_SECONDS', 30),
    internalServiceToken: source.INTERNAL_SERVICE_TOKEN ?? '',
    paymentsUrl: (source.PAYMENTS_URL ?? 'http://127.0.0.1:3002').replace(/\/$/, ''),
    paymentsTimeoutMs: positiveInt(source, 'PAYMENTS_TIMEOUT_MS', 3_000),
    dropStockGate: bool(source.DROP_STOCK_GATE, true),
    dropStockGateResetSeconds: positiveInt(source, 'DROP_STOCK_GATE_RESET_SECONDS', 10),
    shutdownDrainSeconds: nonNegativeInt(source, 'SHUTDOWN_DRAIN_SECONDS', 5),
    httpMaxRequestsPerSocket: nonNegativeInt(source, 'HTTP_MAX_REQUESTS_PER_SOCKET', 0),
    rateLimitEnabled: bool(source.RATE_LIMIT_ENABLED, true),
    rateLimits: {
      default: bucketSize(source, 'RATE_LIMIT_DEFAULT', '60:20'),
      auth: bucketSize(source, 'RATE_LIMIT_AUTH', '10:0.2'),
      checkout: bucketSize(source, 'RATE_LIMIT_CHECKOUT', '5:0.5'),
    },
    trustProxy: bool(source.TRUST_PROXY, false),
  };
}

export const ENV = Symbol('ENV');
