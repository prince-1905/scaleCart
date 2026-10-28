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

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Every module's database is `<prefix><module>`, e.g. scalecart_catalog. Tests use another prefix. */
  databasePrefix: string;
  /** Connections per module pool. Total per process = poolSize x number of modules. */
  poolSize: number;
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
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  stockReservation: StockReservationStrategy;
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

/** Database settings only, so one-off jobs (migrate, seed) don't need the API's secrets. */
export function loadDbConfig(source: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: source.DB_HOST ?? '127.0.0.1',
    port: positiveInt(source, 'DB_PORT', 3307),
    user: source.DB_USER ?? 'scalecart',
    password: source.DB_PASSWORD ?? '',
    databasePrefix: source.DB_PREFIX ?? 'scalecart_',
    poolSize: positiveInt(source, 'DB_POOL_SIZE', 5),
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = positiveInt(source, 'PORT', 3000);

  const httpAdapter = (source.HTTP_ADAPTER ?? 'fastify').toLowerCase();
  if (httpAdapter !== 'fastify' && httpAdapter !== 'express') {
    throw new Error(`Invalid HTTP_ADAPTER: ${source.HTTP_ADAPTER} (expected fastify|express)`);
  }

  // No default: a guessable signing key would let anyone mint access tokens.
  const jwtSecret = source.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters long');
  }

  const labEndpoints = bool(source.LAB_ENDPOINTS, false);
  const stockReservation = (source.STOCK_RESERVATION ?? 'atomic').toLowerCase();
  if (stockReservation !== 'atomic' && stockReservation !== 'locking' && stockReservation !== 'naive') {
    throw new Error(
      `Invalid STOCK_RESERVATION: ${source.STOCK_RESERVATION} (expected atomic|locking|naive)`,
    );
  }
  if (stockReservation !== 'atomic' && !labEndpoints) {
    throw new Error('STOCK_RESERVATION other than atomic is only allowed with LAB_ENDPOINTS=true');
  }

  return {
    port,
    httpAdapter,
    logLevel: source.LOG_LEVEL ?? 'info',
    httpAccessLog: bool(source.HTTP_ACCESS_LOG, true),
    labEndpoints,
    serviceName: source.SERVICE_NAME ?? 'scalecart-api',
    db: loadDbConfig(source),
    jwtSecret,
    accessTokenTtlSeconds: positiveInt(source, 'ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlDays: positiveInt(source, 'REFRESH_TOKEN_TTL_DAYS', 30),
    stockReservation,
  };
}

export const ENV = Symbol('ENV');
