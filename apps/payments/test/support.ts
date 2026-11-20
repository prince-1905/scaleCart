import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { loadEnv } from '../src/config/env.js';
import { RabbitService } from '../src/messaging/rabbit.service.js';
import type { PaymentGateway } from '../src/payments/payment-gateway.js';
import type { ShopOrder } from '../src/shop/shop-client.js';

// The MySQL and RabbitMQ passwords live in the repo's .env (never committed).
const DOT_ENV = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(DOT_ENV)) process.loadEnvFile(DOT_ENV);
if (!process.env.DB_PASSWORD) throw new Error('e2e tests need DB_PASSWORD: copy .env.example to .env at the repo root');

export const JWT_SECRET = 'test-only-secret-0123456789abcdefghijklmnop';
export const SERVICE_TOKEN = 'test-internal-service-token-0123456789abcdef';
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const KEY_SECRET = 'test-key-secret-0123456789';

/**
 * Its own test database (scalecart_test_payments, recreated by global-setup.ts) and its own queue prefix, so these
 * tests never share state with the shop's e2e tests, even when both suites run at once.
 */
export const TEST_ENV: NodeJS.ProcessEnv = {
  DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
  DB_PORT: process.env.DB_PORT ?? '3307',
  // In tests the shared app login creates and owns scalecart_test_*; in Compose the service has its own login.
  PAYMENTS_DB_USER: process.env.DB_USER ?? 'scalecart',
  PAYMENTS_DB_PASSWORD: process.env.DB_PASSWORD,
  PAYMENTS_DB_NAME: 'scalecart_test_payments',
  RABBITMQ_URL: `amqp://scalecart:${process.env.RABBITMQ_PASSWORD ?? ''}@127.0.0.1:5672`,
  MQ_PREFIX: 'test-pay.',
  JWT_SECRET,
  INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
  RAZORPAY_KEY_ID: 'rzp_test_e2e',
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  HTTP_ACCESS_LOG: 'false',
  LOG_LEVEL: 'silent',
  SHOP_TIMEOUT_MS: '300',
  // Jobs run only when a test calls them.
  PAYMENT_JOBS_INTERVAL_SECONDS: '3600',
};

/** The payments service with a fake Razorpay (null = not configured), talking to `shopUrl`. */
export async function startPayments(
  gateway: PaymentGateway | null,
  shopUrl: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<INestApplication> {
  const env = loadEnv({ ...TEST_ENV, SHOP_URL: shopUrl, ...overrides });
  const app = await NestFactory.create(AppModule.forRoot(env, { gateway }), new FastifyAdapter(), {
    logger: false,
    rawBody: true,
  });
  await app.listen(0, '127.0.0.1');
  const rabbit = app.get(RabbitService);
  for (let i = 0; i < 250 && !rabbit.isReady; i++) await sleep(20);
  if (!rabbit.isReady) throw new Error('payments could not connect to RabbitMQ (docker compose up -d rabbitmq?)');
  return app;
}

/**
 * A stand-in for the shop's internal API: GET /internal/orders/:id answers from `orders`. `mode` makes it fail
 * like a real outage: 'down' = 503, 'slow' = answers after 2 s (longer than SHOP_TIMEOUT_MS).
 */
export class FakeShop {
  readonly orders = new Map<string, ShopOrder>();
  mode: 'up' | 'down' | 'slow' = 'up';
  calls = 0;
  /** The X-Request-ID of each call (undefined when none was sent). */
  readonly requestIds: (string | undefined)[] = [];
  private server?: Server;
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      this.calls++;
      this.requestIds.push(req.headers['x-request-id'] as string | undefined);
      if (req.headers['x-service-token'] !== SERVICE_TOKEN) return res.writeHead(401).end();
      const id = /^\/internal\/orders\/([^/]+)$/.exec(req.url ?? '')?.[1] ?? '';
      const answer = () => {
        if (this.mode === 'down') return res.writeHead(503).end();
        const order = this.orders.get(id);
        if (!order) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(order));
      };
      if (this.mode === 'slow') setTimeout(answer, 2_000);
      else answer();
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** An unpaid order of `userId`, payable for the next `minutes`. */
  order(userId: string, totalCents = 2499, minutes = 15): ShopOrder {
    const order: ShopOrder = {
      id: randomUUID(),
      userId,
      status: 'pending_payment',
      totalCents,
      payBy: new Date(Date.now() + minutes * 60_000).toISOString(),
    };
    this.orders.set(order.id, order);
    return order;
  }

  stop() {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}

const jwt = new JwtService({ secret: JWT_SECRET });
/** An access token exactly like the shop issues (same secret, issuer, audience). */
export const customerToken = (userId = randomUUID()) => ({
  userId,
  token: jwt.sign({ sub: userId, role: 'customer' }, { issuer: 'scalecart', audience: 'scalecart-api', expiresIn: 900 }),
});

export const http = (app: INestApplication) => request(app.getHttpServer());
export const db = (app: INestApplication): DataSource => app.get(getDataSourceToken());

/** The events this service wrote for the shop about one order (outbox rows), oldest first. */
export async function eventsFor(app: INestApplication, orderId: string, type = 'payment.captured') {
  const rows: { payload: unknown }[] = await db(app).query(
    'SELECT payload FROM outbox WHERE aggregate_id = ? AND event_type = ? ORDER BY id',
    [orderId, type],
  );
  return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
}

export async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(100);
  }
}
