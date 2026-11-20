import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RabbitService } from '../src/messaging/rabbit.service.js';
import { PAYMENT_EVENTS } from '../src/messaging/topology.js';
import { OrderExpiry } from '../src/orders/order-expiry.js';
import {
  createProduct,
  dataSource,
  eventually,
  http,
  registerAdmin,
  registerUser,
  startApp,
  startWorker,
  TEST_ENV,
  type TestUser,
} from './support.js';

/**
 * The shop's half of the payments split (Phase 8): the internal endpoint the payments service calls, the
 * payment.captured consumer, and order expiry asking the payments service first. The payments service itself is
 * replaced by: events published straight to RabbitMQ, and a tiny fake HTTP server for "paid after all?".
 */
const TOKEN = TEST_ENV.INTERNAL_SERVICE_TOKEN!;
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

describe('payments split: the shop side', () => {
  let app: INestApplication;
  let worker: INestApplication;
  let admin: TestUser;
  let fakePayments: Server;
  /** What the fake payments service answers to "paid after all?", per order id; default: "paid" (keep). */
  const reconcile = new Map<string, 'unpaid' | 'paid' | 'down'>();
  const reconcileCalls: string[] = [];

  beforeAll(async () => {
    fakePayments = createServer((req, res) => {
      const orderId = /\/internal\/orders\/([^/]+)\/reconcile/.exec(req.url ?? '')?.[1] ?? '';
      reconcileCalls.push(orderId);
      if (req.headers['x-service-token'] !== TOKEN) return res.writeHead(401).end();
      // Orders of other test files (running in parallel on the same database) are always kept.
      const answer = reconcile.get(orderId) ?? 'paid';
      if (answer === 'down') return res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ paid: answer === 'paid' }));
    });
    await new Promise<void>((r) => fakePayments.listen(0, '127.0.0.1', r));
    const paymentsUrl = `http://127.0.0.1:${(fakePayments.address() as AddressInfo).port}`;

    app = await startApp();
    worker = await startWorker({ PAYMENTS_URL: paymentsUrl, PAYMENT_TIMEOUT_SECONDS: '1' });
    admin = await registerAdmin(app);
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    fakePayments?.close();
  });

  async function newOrder(stock = 5) {
    const user = await registerUser(app);
    const productId = await createProduct(app, admin, { priceCents: 499_00, stock });
    await http(app).put(`/cart/items/${productId}`).set(bearer(user)).send({ quantity: 1 }).expect(200);
    const res = await http(app).post('/checkout').set(bearer(user)).set('Idempotency-Key', randomUUID()).send({}).expect(201);
    return { user, productId, orderId: res.body.id as string };
  }
  const orderStatus = async (orderId: string) =>
    (await dataSource(app, 'orders').query('SELECT status, payment_id AS paymentId FROM orders WHERE id = ?', [orderId]))[0];
  const reservation = async (orderId: string) =>
    (await dataSource(app, 'inventory').query('SELECT status FROM reservations WHERE order_id = ?', [orderId]))[0]?.status;
  const replies = async (orderId: string) =>
    (
      await dataSource(app, 'orders').query(
        `SELECT payload FROM outbox WHERE event_type = ? AND aggregate_id = ? ORDER BY created_at`,
        [PAYMENT_EVENTS.orderPaymentResult, orderId],
      )
    ).map((r: { payload: unknown }) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));

  function publishCaptured(orderId: string, paymentId: string) {
    const rabbit = worker.get(RabbitService);
    rabbit.publishEvent(PAYMENT_EVENTS.paymentCaptured, { orderId, paymentId, amountPaise: 499_00 }, {
      messageId: randomUUID(),
      type: PAYMENT_EVENTS.paymentCaptured,
      timestamp: Math.floor(Date.now() / 1000),
    });
    return rabbit.confirm();
  }

  describe('GET /internal/orders/:id (what payments asks when a customer clicks Pay)', () => {
    it('answers amount, owner, status and the deadline, with the service token only', async () => {
      const { user, orderId } = await newOrder();
      const ok = await http(app).get(`/internal/orders/${orderId}`).set('X-Service-Token', TOKEN).expect(200);
      expect(ok.body).toMatchObject({ id: orderId, status: 'pending_payment', totalCents: 499_00 });
      expect(Date.parse(ok.body.payBy)).toBeGreaterThan(Date.now());

      await http(app).get(`/internal/orders/${orderId}`).expect(401);
      await http(app).get(`/internal/orders/${orderId}`).set('X-Service-Token', 'x'.repeat(TOKEN.length)).expect(401);
      // A customer's login token is no service token, even for their own order.
      await http(app).get(`/internal/orders/${orderId}`).set(bearer(user)).expect(401);
      await http(app).get(`/internal/orders/${randomUUID()}`).set('X-Service-Token', TOKEN).expect(404);
    });

    it('an empty configured token refuses everything (never open by accident)', async () => {
      const closed = await startApp('fastify', { INTERNAL_SERVICE_TOKEN: '' });
      try {
        await http(closed).get(`/internal/orders/${randomUUID()}`).set('X-Service-Token', '').expect(401);
      } finally {
        await closed.close();
      }
    });
  });

  describe('payment.captured → the order (through RabbitMQ)', () => {
    it('marks the order paid, commits the stock and replies "paid"', async () => {
      const { orderId } = await newOrder();
      await publishCaptured(orderId, 'pay_split_1');
      await eventually(async () => (await orderStatus(orderId)).status === 'paid');
      expect((await orderStatus(orderId)).paymentId).toBe('pay_split_1');
      // Stock is committed right AFTER the "paid" transaction, so it can lag the status by a moment (this flaked once
      // in a busy full run, 2026-11-18).
      await eventually(async () => (await reservation(orderId)) === 'committed');
      expect(await replies(orderId)).toEqual([{ orderId, paymentId: 'pay_split_1', result: 'paid' }]);
    });

    it('a second payment for a paid order → "paid_by_other" (payments refunds it); a repeat adds no reply', async () => {
      const { orderId } = await newOrder();
      await publishCaptured(orderId, 'pay_first');
      await eventually(async () => (await orderStatus(orderId)).status === 'paid');
      await publishCaptured(orderId, 'pay_second');
      await publishCaptured(orderId, 'pay_first'); // redelivered / repeated
      await eventually(async () => (await replies(orderId)).length === 2);
      // Give the repeat time to be processed too: it must not add a third reply.
      await new Promise((r) => setTimeout(r, 1000));
      const all = await replies(orderId);
      expect(all).toHaveLength(2);
      expect(all).toContainEqual({ orderId, paymentId: 'pay_second', result: 'paid_by_other' });
      expect((await orderStatus(orderId)).paymentId).toBe('pay_first');
    });

    it('money for an order that already expired → "cancelled" (payments refunds it)', async () => {
      const { orderId } = await newOrder();
      await dataSource(app, 'orders').query(`UPDATE orders SET status = 'cancelled' WHERE id = ?`, [orderId]);
      await publishCaptured(orderId, 'pay_late');
      await eventually(async () => (await replies(orderId)).length === 1);
      expect((await replies(orderId))[0].result).toBe('cancelled');
      expect((await orderStatus(orderId)).status).toBe('cancelled');
    });
  });

  describe('order expiry asks the payments service first', () => {
    it('unpaid → cancelled and stock back; paid after all → kept; payments down → kept (never cancel unchecked)', async () => {
      const unpaid = await newOrder(3);
      const paid = await newOrder(3);
      const unknown = await newOrder(3);
      reconcile.set(unpaid.orderId, 'unpaid');
      reconcile.set(paid.orderId, 'paid');
      reconcile.set(unknown.orderId, 'down');
      await new Promise((r) => setTimeout(r, 1200)); // PAYMENT_TIMEOUT_SECONDS=1 on the worker

      const round = await worker.get(OrderExpiry).runOnce();
      expect(round.cancelled).toBeGreaterThanOrEqual(1);
      expect((await orderStatus(unpaid.orderId)).status).toBe('cancelled');
      expect(await reservation(unpaid.orderId)).toBe('released');
      expect((await http(app).get(`/inventory/${unpaid.productId}`).expect(200)).body.available).toBe(3);

      expect((await orderStatus(paid.orderId)).status).toBe('pending_payment');
      expect((await orderStatus(unknown.orderId)).status).toBe('pending_payment');
      expect(reconcileCalls).toEqual(expect.arrayContaining([unpaid.orderId, paid.orderId, unknown.orderId]));
    });
  });
});
