import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { generateKeyPairSync } from 'node:crypto';
import { loadEnv } from '../config/env.js';

// The identity service needs a signing key and the service token to start; any will do for these checks.
const BASE = {
  JWT_SECRET: 'x'.repeat(32),
  INTERNAL_SERVICE_TOKEN: 'y'.repeat(32),
  IDENTITY_SIGNING_KEY_ID: 'unit',
  IDENTITY_SIGNING_KEY: Buffer.from(
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  ).toString('base64'),
};
import { MetricsService } from '../observability/metrics.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { LocalTokenBucket, type TokenBucket } from './token-bucket.js';

const env = loadEnv(BASE);

function context(req: object): ExecutionContext {
  const res = { header: () => res };
  return {
    getType: () => 'http',
    getHandler: () => () => {},
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  it('when Redis cannot answer, this pod’s own bucket still limits (no "fail open" leak, E9)', async () => {
    const metrics = new MetricsService();
    const bucket = { take: async () => undefined } as unknown as TokenBucket;
    const guard = new RateLimitGuard(new Reflector(), bucket, metrics, env); // default 60:20
    const req = { headers: {}, ip: '1.2.3.4' };

    for (let i = 0; i < 60; i++) await expect(guard.canActivate(context(req))).resolves.toBe(true);
    await expect(guard.canActivate(context(req))).rejects.toMatchObject({ status: 429 });
    // Another caller has a full bucket of their own.
    await expect(guard.canActivate(context({ headers: {}, ip: '5.6.7.8' }))).resolves.toBe(true);

    const text = await metrics.registry.metrics();
    expect(text).toContain('rate_limit_total{policy="default",result="allowed",source="local"} 61');
    expect(text).toContain('rate_limit_total{policy="default",result="limited",source="local"} 1');
  });

  it('counts a logged-in caller by user id, a logged-out one by IP', async () => {
    const keys: string[] = [];
    const bucket = {
      take: async (key: string) => (keys.push(key), { allowed: true, remaining: 1, retryAfterMs: 0 }),
    } as unknown as TokenBucket;
    const guard = new RateLimitGuard(new Reflector(), bucket, new MetricsService(), env);

    await guard.canActivate(context({ headers: {}, ip: '1.2.3.4', user: { id: 'u1', role: 'customer' } }));
    await guard.canActivate(context({ headers: { 'x-real-ip': '9.9.9.9' }, ip: '1.2.3.4' }));
    expect(keys).toEqual(['ratelimit:default:u:u1', 'ratelimit:default:ip:1.2.3.4']);
  });
});

describe('LocalTokenBucket', () => {
  it('refills with time, caps at the capacity, and says how long to wait', () => {
    let now = 0;
    const bucket = new LocalTokenBucket(() => now);
    const size = { capacity: 2, refillPerSecond: 4 }; // one token per 250 ms

    expect(bucket.take('k', size).allowed).toBe(true);
    expect(bucket.take('k', size).allowed).toBe(true);
    expect(bucket.take('k', size)).toMatchObject({ allowed: false, retryAfterMs: 250 });
    now += 250;
    expect(bucket.take('k', size).allowed).toBe(true);
    now += 10_000; // long quiet: still only 2
    expect(bucket.take('k', size).allowed).toBe(true);
    expect(bucket.take('k', size).allowed).toBe(true);
    expect(bucket.take('k', size).allowed).toBe(false);
  });
});

describe('rate limit settings', () => {
  it('reads "capacity:refillPerSecond" and rejects nonsense', () => {
    const base = BASE;
    expect(loadEnv({ ...base, RATE_LIMIT_AUTH: '10:0.2' }).rateLimits.auth).toEqual({ capacity: 10, refillPerSecond: 0.2 });
    expect(() => loadEnv({ ...base, RATE_LIMIT_DEFAULT: '10' })).toThrow(/RATE_LIMIT_DEFAULT/);
    expect(() => loadEnv({ ...base, RATE_LIMIT_DEFAULT: '0:5' })).toThrow();
  });
});
