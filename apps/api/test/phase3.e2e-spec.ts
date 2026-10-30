import type { INestApplication } from '@nestjs/common';
import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { RabbitService } from '../src/messaging/rabbit.service.js';
import { ORDER_CREATED } from '../src/orders/events.js';
import { CleanupService } from '../src/worker/cleanup.service.js';
import {
  createProduct,
  dataSource,
  eventually,
  http,
  mailpitCount,
  registerAdmin,
  registerUser,
  startApp,
  startWorker,
  TEST_ENV,
  type TestUser,
} from './support.js';

async function buy(app: INestApplication, user: TestUser, productId: number, status = 201) {
  await http(app)
    .put(`/cart/items/${productId}`)
    .auth(user.accessToken, { type: 'bearer' })
    .send({ quantity: 1 })
    .expect(200);
  return http(app)
    .post('/checkout')
    .auth(user.accessToken, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({})
    .expect(status);
}

describe('order events (outbox â†’ RabbitMQ â†’ email)', () => {
  let api: INestApplication;
  let worker: INestApplication;
  let admin: TestUser;
  let productId: number;

  beforeAll(async () => {
    api = await startApp('fastify');
    worker = await startWorker();
    admin = await registerAdmin(api);
    productId = await createProduct(api, admin, { stock: 1_000 });
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
  });

  it('saves the order.created event in the same transaction as the order', async () => {
    const user = await registerUser(api);
    const order = (await buy(api, user, productId)).body;

    const rows = await dataSource(api, 'orders').query(
      'SELECT event_type AS type, payload FROM outbox WHERE aggregate_id = ?',
      [order.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(ORDER_CREATED);
    expect(rows[0].payload).toMatchObject({ orderId: order.id, userId: expect.any(String), totalCents: order.totalCents });
  });

  it('delivers the confirmation email, then marks the event published', async () => {
    const user = await registerUser(api);
    const order = (await buy(api, user, productId)).body;

    await eventually(async () => (await mailpitCount(`Order ${order.id}`)) === 1);
    const [event] = await dataSource(api, 'orders').query(
      'SELECT published_at AS publishedAt FROM outbox WHERE aggregate_id = ?',
      [order.id],
    );
    expect(event.publishedAt).not.toBeNull();
  });

  it('sends one email even when the same event is delivered three times', async () => {
    const user = await registerUser(api);
    const order = (await buy(api, user, productId)).body;
    await eventually(async () => (await mailpitCount(`Order ${order.id}`)) === 1);

    // Simulate redelivery (relay crash after publishing, broker redelivery...).
    const [row] = await dataSource(api, 'orders').query(
      'SELECT id, payload FROM outbox WHERE aggregate_id = ?',
      [order.id],
    );
    const rabbit = worker.get(RabbitService);
    for (let i = 0; i < 2; i++) {
      rabbit.publishEvent(ORDER_CREATED, row.payload, { messageId: row.id, type: ORDER_CREATED });
    }
    await rabbit.confirm();

    await new Promise((r) => setTimeout(r, 1_500));
    expect(await mailpitCount(`Order ${order.id}`)).toBe(1);
  });

  it('parks an unreadable message in the dead-letter queue instead of retrying forever', async () => {
    const rabbit = worker.get(RabbitService);
    const conn = await connect(TEST_ENV.RABBITMQ_URL!);
    const ch = await conn.createChannel();
    const before = (await ch.checkQueue(rabbit.names.notificationsDead)).messageCount;

    rabbit.publishEvent(ORDER_CREATED, 'this is not an event', { messageId: randomUUID(), type: 'garbage' });
    await rabbit.confirm();

    await eventually(async () => (await ch.checkQueue(rabbit.names.notificationsDead)).messageCount === before + 1);
    await conn.close();
  });

  describe('cleanup jobs', () => {
    it('gives back stock held for an order that was never created', async () => {
      const inventory = worker.get(InventoryService);
      const orphan = randomUUID();
      await inventory.reserve(orphan, [{ productId, quantity: 5 }]);
      const stockAfterReserve = (await http(api).get(`/inventory/${productId}`)).body.available;

      // Pretend the API crashed an hour ago, right after reserving.
      await dataSource(worker, 'inventory').query(
        `UPDATE reservations SET created_at = NOW(3) - INTERVAL 1 HOUR WHERE order_id = ?`,
        [orphan],
      );
      const result = await worker.get(CleanupService).runOnce();

      expect(result.releasedReservations).toBeGreaterThanOrEqual(1);
      expect((await http(api).get(`/inventory/${productId}`)).body.available).toBe(stockAfterReserve + 5);
    });

    it('keeps stock held by real orders', async () => {
      const user = await registerUser(api);
      const order = (await buy(api, user, productId)).body;
      await dataSource(worker, 'inventory').query(
        `UPDATE reservations SET created_at = NOW(3) - INTERVAL 1 HOUR WHERE order_id = ?`,
        [order.id],
      );
      await worker.get(CleanupService).runOnce();

      const [row] = await dataSource(worker, 'inventory').query(
        'SELECT status FROM reservations WHERE order_id = ?',
        [order.id],
      );
      expect(row.status).toBe('reserved');
    });

    it('forgets idempotency keys older than a day', async () => {
      const key = `old-${randomUUID()}`;
      await dataSource(api, 'orders').query(
        `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, order_id, status, claimed_at, created_at)
         VALUES (?, ?, REPEAT('0', 64), ?, 'completed', NOW(3), NOW(3) - INTERVAL 2 DAY)`,
        [randomUUID(), key, randomUUID()],
      );
      await worker.get(CleanupService).runOnce();
      const rows = await dataSource(api, 'orders').query('SELECT 1 FROM idempotency_keys WHERE idem_key = ?', [key]);
      expect(rows).toHaveLength(0);
    });
  });
});

describe('sending the email inside the request (lab-only NOTIFY_MODE=sync)', () => {
  it('emails before answering, and writes no outbox event', async () => {
    const api = await startApp('fastify', { LAB_ENDPOINTS: 'true', NOTIFY_MODE: 'sync' });
    const admin = await registerAdmin(api);
    const productId = await createProduct(api, admin);
    const user = await registerUser(api);

    const order = (await buy(api, user, productId)).body;

    expect(await mailpitCount(`Order ${order.id}`)).toBe(1);
    const rows = await dataSource(api, 'orders').query('SELECT 1 FROM outbox WHERE aggregate_id = ?', [order.id]);
    expect(rows).toHaveLength(0);
    await api.close();
  });

  it('shows the dual-write problem: mail server down = error, yet the order exists', async () => {
    const api = await startApp('fastify', { LAB_ENDPOINTS: 'true', NOTIFY_MODE: 'sync', SMTP_PORT: '1' });
    const admin = await registerAdmin(api);
    const productId = await createProduct(api, admin);
    const user = await registerUser(api);

    await buy(api, user, productId, 500);

    const orders = await http(api).get('/orders').auth(user.accessToken, { type: 'bearer' }).expect(200);
    expect(orders.body.items).toHaveLength(1); // the customer was told "error", but was charged
    await api.close();
  });
});
