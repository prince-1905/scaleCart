/**
 * The payments service's settings. It knows only what it needs: its own database, Razorpay, RabbitMQ, the shop's
 * internal address and the shared service token. No shop database, no Redis, no catalog or cart settings.
 */
export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The one database this service owns (scalecart_payments; tests use scalecart_test_payments). */
  database: string;
  poolSize: number;
}

export interface PaymentsEnv {
  port: number;
  logLevel: string;
  httpAccessLog: boolean;
  serviceName: string;
  db: DbConfig;
  /**
   * The identity service (Phase 11): its public keys (/.well-known/jwks.json) check customers' access tokens. This
   * service has no secret or private key: it can check a token, never create one.
   */
  identityUrl: string;
  identityTimeoutMs: number;
  rabbitmqUrl: string;
  /** Prefix for exchange and queue names (`test.` in e2e tests). */
  mqPrefix: string;
  /** Razorpay test/live keys. Empty = payments off (the routes answer 503). */
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  /** The shop's address inside the network (never through NGINX), e.g. http://api:3000. */
  shopUrl: string;
  /** Sent on every call between the two services; each side refuses /internal/* calls without it. */
  serviceToken: string;
  /** How long to wait for the shop before giving up (a call is retried once). */
  shopTimeoutMs: number;
  /** How often the refund and outbox-cleanup jobs run. */
  jobsIntervalSeconds: number;
  /** On SIGTERM, keep serving this long with "Connection: close" before closing. */
  shutdownDrainSeconds: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(source: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = source[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

export function loadDbConfig(source: NodeJS.ProcessEnv = process.env): DbConfig {
  const database = source.PAYMENTS_DB_NAME ?? 'scalecart_payments';
  // Database names can't be bound as query parameters, so only allow safe characters.
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error(`Unsafe database name: ${database}`);
  return {
    host: source.DB_HOST ?? '127.0.0.1',
    port: int(source, 'DB_PORT', 3307),
    user: source.PAYMENTS_DB_USER ?? 'payments',
    password: source.PAYMENTS_DB_PASSWORD ?? '',
    database,
    poolSize: int(source, 'DB_POOL_SIZE', 5),
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): PaymentsEnv {
  const serviceToken = source.INTERNAL_SERVICE_TOKEN ?? '';
  if (serviceToken.length < 32) throw new Error('INTERNAL_SERVICE_TOKEN must be set (at least 32 characters)');

  return {
    port: int(source, 'PORT', 3002),
    logLevel: source.LOG_LEVEL ?? 'info',
    httpAccessLog: bool(source.HTTP_ACCESS_LOG, true),
    serviceName: source.SERVICE_NAME ?? 'scalecart-payments',
    db: loadDbConfig(source),
    identityUrl: (source.IDENTITY_URL ?? 'http://127.0.0.1:3003').replace(/\/$/, ''),
    identityTimeoutMs: int(source, 'IDENTITY_TIMEOUT_MS', 1_000),
    rabbitmqUrl: source.RABBITMQ_URL ?? 'amqp://scalecart:scalecart@127.0.0.1:5672',
    mqPrefix: source.MQ_PREFIX ?? '',
    razorpayKeyId: source.RAZORPAY_KEY_ID ?? '',
    razorpayKeySecret: source.RAZORPAY_KEY_SECRET ?? '',
    razorpayWebhookSecret: source.RAZORPAY_WEBHOOK_SECRET ?? '',
    shopUrl: (source.SHOP_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, ''),
    serviceToken,
    shopTimeoutMs: int(source, 'SHOP_TIMEOUT_MS', 1_000),
    jobsIntervalSeconds: int(source, 'PAYMENT_JOBS_INTERVAL_SECONDS', 30),
    shutdownDrainSeconds: int(source, 'SHUTDOWN_DRAIN_SECONDS', 5, 0),
  };
}

export const ENV = Symbol('ENV');
