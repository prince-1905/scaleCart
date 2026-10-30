import type { INestApplication } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { createApp, listen } from '../src/app.factory.js';
import { RedisService } from '../src/cache/redis.service.js';
import { RabbitService } from '../src/messaging/rabbit.service.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { loadEnv, type HttpAdapterName } from '../src/config/env.js';
import type { ModuleName } from '../src/database/database.js';

// The Compose MySQL password lives in the repo's .env (never committed).
const DOT_ENV = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(DOT_ENV)) process.loadEnvFile(DOT_ENV);
if (!process.env.DB_PASSWORD) {
  throw new Error('e2e tests need DB_PASSWORD: copy .env.example to .env at the repo root');
}

/**
 * E2E tests run against the Compose MySQL (localhost:3307) in their own databases
 * (scalecart_test_*), recreated by global-setup.ts before every run.
 */
export const TEST_ENV: NodeJS.ProcessEnv = {
  DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
  DB_PORT: process.env.DB_PORT ?? '3307',
  DB_USER: process.env.DB_USER ?? 'scalecart',
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_PREFIX: 'scalecart_test_',
  // Redis database 1, so tests never touch the app's cache (database 0).
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
  // Own exchange and queues ("test." prefix), so the dev stack's worker never takes test messages.
  RABBITMQ_URL: `amqp://scalecart:${process.env.RABBITMQ_PASSWORD ?? ''}@127.0.0.1:5672`,
  MQ_PREFIX: 'test.',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  // Signs tokens for throwaway test apps only; never used by a real deployment.
  JWT_SECRET: 'test-only-secret-0123456789abcdefghijklmnop',
  HTTP_ACCESS_LOG: 'false',
  LOG_LEVEL: 'silent',
};

export async function startApp(
  adapter: HttpAdapterName = 'fastify',
  overrides: NodeJS.ProcessEnv = {},
): Promise<INestApplication> {
  const env = loadEnv({ ...TEST_ENV, HTTP_ADAPTER: adapter, ...overrides });
  const app = await createApp(env, { logger: false });
  // Listen on a random port: otherwise supertest starts a listener per request,
  // which piles up during the concurrency tests.
  await listen(app, { ...env, port: 0 }, '127.0.0.1');
  await waitForRedis(app);
  return app;
}

/** The background worker (outbox relay, email consumer, cleanup), connected to RabbitMQ. */
export async function startWorker(overrides: NodeJS.ProcessEnv = {}): Promise<INestApplication> {
  const env = loadEnv({ ...TEST_ENV, CLEANUP_INTERVAL_SECONDS: '3600', ...overrides }, 'worker');
  const app = await NestFactory.create(WorkerModule.forRoot(env), new FastifyAdapter(), { logger: false });
  await app.listen(0, '127.0.0.1');
  const rabbit = app.get(RabbitService);
  for (let i = 0; i < 250 && !rabbit.isReady; i++) await sleep(20);
  if (!rabbit.isReady) throw new Error('worker could not connect to RabbitMQ (docker compose up -d rabbitmq?)');
  return app;
}

/** Emails in Mailpit whose subject contains `text`. */
export async function mailpitCount(text: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`subject:"${text}"`)}`);
  const body = (await res.json()) as { messages_count: number };
  return body.messages_count;
}

/** Polls until `check` is true (or fails after `timeoutMs`). */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(100);
  }
}

/** Redis connects in the background (the app never waits for it); tests do. */
async function waitForRedis(app: INestApplication) {
  const redis = app.get(RedisService);
  for (let i = 0; i < 50 && !redis.isReady; i++) await sleep(20);
}

/** Current value of a Prometheus counter in this app instance, e.g. cache hits. */
export async function metric(app: INestApplication, pattern: RegExp): Promise<number> {
  const res = await http(app).get('/metrics').expect(200);
  return Number(res.text.match(pattern)?.[1] ?? 0);
}

export const http = (app: INestApplication) => request(app.getHttpServer());

export const dataSource = (app: INestApplication, module: ModuleName): DataSource =>
  app.get(getDataSourceToken(module), { strict: false });

/** Unique per call, so test files can share the databases and run in parallel. */
export const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export interface TestUser {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(app: INestApplication): Promise<TestUser> {
  const email = `${unique('user')}@test.local`;
  const password = 'correct-horse-battery';
  const res = await http(app).post('/auth/register').send({ email, password }).expect(201);
  return { email, password, ...res.body };
}

export async function registerAdmin(app: INestApplication): Promise<TestUser> {
  const user = await registerUser(app);
  await dataSource(app, 'identity').query(`UPDATE users SET role = 'admin' WHERE email = ?`, [
    user.email,
  ]);
  // The role is inside the access token, so log in again to get one that says admin.
  const res = await http(app)
    .post('/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);
  return { ...user, ...res.body };
}

export async function createProduct(
  app: INestApplication,
  admin: TestUser,
  { priceCents = 1999, stock = 10, name = 'Test product' } = {},
): Promise<number> {
  const res = await http(app)
    .post('/products')
    .auth(admin.accessToken, { type: 'bearer' })
    .send({ sku: unique('SKU'), name, priceCents, description: 'made for tests' })
    .expect(201);
  await http(app)
    .put(`/inventory/${res.body.id}`)
    .auth(admin.accessToken, { type: 'bearer' })
    .send({ available: stock })
    .expect(200);
  return res.body.id;
}
