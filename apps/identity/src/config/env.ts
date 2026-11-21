/**
 * The identity service's settings (Phase 11). It owns users, passwords, refresh tokens, 2FA and the SIGNING KEY:
 * the only service that can create access tokens. Everyone else gets only the public keys (JWKS).
 */
import type { RateLimitPolicy } from '../rate-limit/rate-limit.js';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The one database this service owns (scalecart_identity; tests use scalecart_test_identity). */
  database: string;
  poolSize: number;
}

export interface BucketSize {
  capacity: number;
  refillPerSecond: number;
}

/** One RSA key: its id (`kid` in the token header) and the PEM text. */
export interface KeyEntry {
  kid: string;
  pem: string;
}

export interface Env {
  port: number;
  logLevel: string;
  httpAccessLog: boolean;
  serviceName: string;
  db: DbConfig;
  redisUrl: string;
  /** The private key that signs access tokens (RS256), and its id. Only this service has it. */
  signingKey: KeyEntry;
  /** Older public keys still accepted while their tokens live out (key rotation). Published in the JWKS too. */
  extraPublicKeys: KeyEntry[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  loginMaxFailures: number;
  loginFailureWindowSeconds: number;
  /**
   * Only for 2FA: secrets at rest are encrypted with a key derived from TOTP_ENCRYPTION_KEY, or from JWT_SECRET when
   * that's empty (as before the split, so existing 2FA users keep working). It signs nothing.
   */
  totpEncryptionKey: string;
  jwtSecret: string;
  twoFactorMaxFailures: number;
  twoFactorLockSeconds: number;
  rateLimitEnabled: boolean;
  rateLimits: Record<RateLimitPolicy, BucketSize>;
  trustProxy: boolean;
  /** Sent by the shop on /internal/* calls (user emails). */
  internalServiceToken: string;
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

/** "capacity:refillPerSecond", e.g. "10:0.2" = bursts of 10, then one every 5 s. */
function bucketSize(source: NodeJS.ProcessEnv, name: string, fallback: string): BucketSize {
  const raw = source[name] || fallback;
  const [capacity, refillPerSecond] = raw.split(':').map(Number);
  if (!Number.isInteger(capacity) || capacity <= 0 || !(refillPerSecond > 0)) {
    throw new Error(`Invalid ${name}: ${raw} (expected capacity:refillPerSecond, e.g. 10:0.2)`);
  }
  return { capacity, refillPerSecond };
}

/** PEM keys travel through .env as one line: base64 of the PEM text. */
export const pemFromBase64 = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

/** "kid1:<base64 PEM>,kid2:<base64 PEM>" → entries. */
export function parseKeyList(raw: string | undefined): KeyEntry[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const at = item.indexOf(':');
      if (at <= 0) throw new Error('key list entries must look like kid:<base64 PEM>');
      return { kid: item.slice(0, at), pem: pemFromBase64(item.slice(at + 1)) };
    });
}

export function loadDbConfig(source: NodeJS.ProcessEnv = process.env): DbConfig {
  const database = source.IDENTITY_DB_NAME ?? 'scalecart_identity';
  // Database names can't be bound as query parameters, so only allow safe characters.
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error(`Unsafe database name: ${database}`);
  return {
    host: source.DB_HOST ?? '127.0.0.1',
    port: int(source, 'DB_PORT', 3307),
    user: source.IDENTITY_DB_USER ?? 'identity',
    password: source.IDENTITY_DB_PASSWORD ?? '',
    database,
    poolSize: int(source, 'DB_POOL_SIZE', 5),
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const signingKeyB64 = source.IDENTITY_SIGNING_KEY ?? '';
  const kid = source.IDENTITY_SIGNING_KEY_ID ?? '';
  if (!signingKeyB64 || !kid) {
    throw new Error('IDENTITY_SIGNING_KEY and IDENTITY_SIGNING_KEY_ID must be set (node infra/identity/new-signing-key.mjs)');
  }
  const serviceToken = source.INTERNAL_SERVICE_TOKEN ?? '';
  if (serviceToken.length < 32) throw new Error('INTERNAL_SERVICE_TOKEN must be set (at least 32 characters)');
  const jwtSecret = source.JWT_SECRET ?? '';
  const totpEncryptionKey = source.TOTP_ENCRYPTION_KEY ?? '';
  if (!totpEncryptionKey && jwtSecret.length < 32) {
    throw new Error('TOTP_ENCRYPTION_KEY or JWT_SECRET (at least 32 characters) must be set: 2FA secrets are encrypted with it');
  }

  return {
    port: int(source, 'PORT', 3003),
    logLevel: source.LOG_LEVEL ?? 'info',
    httpAccessLog: bool(source.HTTP_ACCESS_LOG, true),
    serviceName: source.SERVICE_NAME ?? 'scalecart-identity',
    db: loadDbConfig(source),
    redisUrl: source.REDIS_URL ?? 'redis://127.0.0.1:6379',
    signingKey: { kid, pem: pemFromBase64(signingKeyB64) },
    extraPublicKeys: parseKeyList(source.IDENTITY_EXTRA_PUBLIC_KEYS).filter((k) => k.kid !== kid),
    accessTokenTtlSeconds: int(source, 'ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlDays: int(source, 'REFRESH_TOKEN_TTL_DAYS', 30),
    loginMaxFailures: int(source, 'LOGIN_MAX_FAILURES', 5),
    loginFailureWindowSeconds: int(source, 'LOGIN_FAILURE_WINDOW_SECONDS', 900),
    totpEncryptionKey,
    jwtSecret,
    twoFactorMaxFailures: int(source, 'TWO_FACTOR_MAX_FAILURES', 5),
    twoFactorLockSeconds: int(source, 'TWO_FACTOR_LOCK_SECONDS', 900),
    rateLimitEnabled: bool(source.RATE_LIMIT_ENABLED, true),
    rateLimits: {
      default: bucketSize(source, 'RATE_LIMIT_DEFAULT', '60:20'),
      auth: bucketSize(source, 'RATE_LIMIT_AUTH', '10:0.2'),
      checkout: bucketSize(source, 'RATE_LIMIT_CHECKOUT', '5:0.5'),
    },
    trustProxy: bool(source.TRUST_PROXY, false),
    internalServiceToken: serviceToken,
    shutdownDrainSeconds: int(source, 'SHUTDOWN_DRAIN_SECONDS', 5, 0),
  };
}

export const ENV = Symbol('ENV');
