import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { getDataSourceToken } from '@nestjs/typeorm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { RedisService } from '../src/cache/redis.service.js';
import { loadEnv } from '../src/config/env.js';

// The MySQL password lives in the repo's .env (never committed).
const DOT_ENV = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(DOT_ENV)) process.loadEnvFile(DOT_ENV);
if (!process.env.DB_PASSWORD) throw new Error('e2e tests need DB_PASSWORD: copy .env.example to .env at the repo root');

export const SERVICE_TOKEN = 'test-internal-service-token-0123456789abcdef';

/** A fresh RSA key per test run, as base64 PEM (the same shape as in .env). */
export function newTestKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateB64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64'),
    publicB64: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }) as string).toString('base64'),
  };
}
export const KEY = newTestKey();
export const KID = 'test-key-1';

/**
 * Its own test database (scalecart_test_identity, recreated by global-setup.ts) and Redis database 2, so these tests
 * never share state with the shop's or payments' e2e tests, even when the suites run at the same time.
 */
export const TEST_ENV: NodeJS.ProcessEnv = {
  DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
  DB_PORT: process.env.DB_PORT ?? '3307',
  // In tests the shared app login creates and owns scalecart_test_*; in Compose the service has its own login.
  IDENTITY_DB_USER: process.env.DB_USER ?? 'scalecart',
  IDENTITY_DB_PASSWORD: process.env.DB_PASSWORD,
  IDENTITY_DB_NAME: 'scalecart_test_identity',
  // REDIS_PORT (.env) = the Compose Redis's host port, when 6379 is taken by something else on the machine.
  REDIS_URL: `redis://127.0.0.1:${process.env.REDIS_PORT ?? '6379'}/2`,
  IDENTITY_SIGNING_KEY: KEY.privateB64,
  IDENTITY_SIGNING_KEY_ID: KID,
  INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
  // Only derives the 2FA encryption key here (tokens are RS256).
  JWT_SECRET: 'test-only-secret-0123456789abcdefghijklmnop',
  // Every test request comes from 127.0.0.1: one shared bucket would throttle the whole suite (tests turn it on).
  RATE_LIMIT_ENABLED: 'false',
  HTTP_ACCESS_LOG: 'false',
  LOG_LEVEL: 'silent',
};

export async function startIdentity(overrides: NodeJS.ProcessEnv = {}): Promise<INestApplication> {
  const env = loadEnv({ ...TEST_ENV, ...overrides });
  const app = await NestFactory.create(AppModule.forRoot(env), new FastifyAdapter({ trustProxy: env.trustProxy }), {
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const redis = app.get(RedisService);
  for (let i = 0; i < 50 && !redis.isReady; i++) await sleep(20);
  return app;
}

export const http = (app: INestApplication) => request(app.getHttpServer());

/** The identity database ("identity" connection), for checks the HTTP API can't show. */
export const dataSource = (app: INestApplication, _name: 'identity' = 'identity'): DataSource =>
  app.get(getDataSourceToken('identity'), { strict: false });

export const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export interface TestUser {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

export async function registerUser(app: INestApplication): Promise<TestUser> {
  const email = `${unique('user')}@test.local`;
  const password = 'correct-horse-battery';
  const res = await http(app).post('/auth/register').send({ email, password }).expect(201);
  return { email, password, ...res.body };
}
