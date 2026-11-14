import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PaymentsService } from '../src/payments/payments.service.js';
import { signCheckout, signWebhook } from '../src/payments/signatures.js';
import { FakeRazorpay, webhookBody } from './fake-razorpay.js';
import {
  createProduct,
  dataSource,
  http,
  metric,
  registerAdmin,
  registerUser,
  startApp,
  startAppWithGateway,
  TEST_PAYMENT_ENV,
  type TestUser,
} from './support.js';
import type { GatewayPayment } from '../src/payments/payment-gateway.js';

const SECRET = TEST_PAYMENT_ENV.RAZORPAY_WEBHOOK_SECRET;

/** Delivers a webhook the way Razorpay does: signed raw body, event id header. */
function deliver(app: INestApplication, body: string, { eventId = `evt_${randomUUID()}`, signature = signWebhook(body, SECRET) } = {}) {
  return http(app)
    .post('/payments/razorpay/webhook')
    .set('content-type', 'application/json')
    .set('x-razorpay-signature', signature)
    .set('x-razorpay-event-id', eventId)
    .send(body);
}

async function placeOrder(app: INestApplication, user: TestUser, productId: number) {
  await http(app).put(`/cart/items/${productId}`).auth(user.accessToken, { type: 'bearer' }).send({ quantity: 1 }).expect(200);
  const res = await http(app)
    .post('/checkout')
    .auth(user.accessToken, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({})
    .expect(201);
  return res.body as { id: string; totalCents: number };
}

const startPayment = (app: INestApplication, user: TestUser, orderId: string, status = 201) =>
  http(app).post(`/orders/${orderId}/payment`).auth(user.accessToken, { type: 'bearer' }).expect(status);

const orderStatus = async (app: INestApplication, user: TestUser, orderId: string) =>
  (await http(app).get(`/orders/${orderId}`).auth(user.accessToken, { type: 'bearer' }).expect(200)).body.status;

const reservationStatus = async (app: INestApplication, orderId: string) =>
  (await dataSource(app, 'inventory').query('SELECT status FROM reservations WHERE order_id = ?', [orderId]))[0]?.status;

const paymentRow = async (app: INestApplication, paymentId: string) =>
  (await dataSource(app, 'payments').query('SELECT status, refund_reason AS refundReason FROM payments WHERE id = ?', [paymentId]))[0];

const available = async (app: INestApplication, productId: number) =>
  (await http(app).get(`/inventory/${productId}`)).body.available as number;

/** Pretends the order was placed long ago, past the payment timeout. */
const ageOrder = (app: INestApplication, orderId: string) =>
  dataSource(app, 'orders').query(`UPDATE orders SET created_at = NOW(3) - INTERVAL 1 HOUR WHERE id = ?`, [orderId]);

describe.each(['fastify', 'express'] as const)('payments with Razorpay webhooks (%s)', (adapter) => {
  let app: INestApplication;
  let fake: FakeRazorpay;
  let admin: TestUser;
  let productId: number;

  beforeAll(async () => {
    fake = new FakeRazorpay();
    app = await startAppWithGateway(fake, adapter);
    admin = await registerAdmin(app);
    productId = await createProduct(app, admin, { priceCents: 2499, stock: 1000 });
  });
  afterAll(() => app.close());
  beforeEach(() => {
    fake.down = false;
  });

  it('pay → signed webhook → order paid and its stock sold for good', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);

    const session = (await startPayment(app, user, order.id)).body;
    expect(session).toMatchObject({ orderId: order.id, provider: 'razorpay', keyId: 'rzp_test_e2e', amountPaise: 2499, currency: 'INR' });
    expect(session.providerOrderId).toMatch(/^order_/);
    // A second click before paying reuses the same provider order.
    expect((await startPayment(app, user, order.id)).body.providerOrderId).toBe(session.providerOrderId);

    const payment = fake.pay(session.providerOrderId);
    const res = await deliver(app, webhookBody('payment.captured', payment)).expect(200);

    expect(res.body).toEqual({ status: 'processed', outcome: 'paid' });
    expect(await orderStatus(app, user, order.id)).toBe('paid');
    expect(await reservationStatus(app, order.id)).toBe('committed');
    expect((await startPayment(app, user, order.id, 409)).body.error).toBe('order_paid');
  });

  it('rejects a forged or altered webhook and changes nothing', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    const session = (await startPayment(app, user, order.id)).body;
    const body = webhookBody('payment.captured', fake.pay(session.providerOrderId));

    await deliver(app, body, { signature: signWebhook(body, 'wrong-secret') }).expect(400);
    // Signed correctly, then one byte changed on the way: the signature no longer matches.
    await deliver(app, body.replace('"amount":2499', '"amount":2490'), { signature: signWebhook(body, SECRET) }).expect(400);
    await http(app).post('/payments/razorpay/webhook').set('content-type', 'application/json').send(body).expect(400);

    expect(await orderStatus(app, user, order.id)).toBe('pending_payment');
  });

  it('the same event delivered 20 times at once pays the order exactly once', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    const session = (await startPayment(app, user, order.id)).body;
    const body = webhookBody('payment.captured', fake.pay(session.providerOrderId));
    const paidBefore = await metric(app, /payments_total\{outcome="paid",source="webhook"\} (\d+)/);

    const results = await Promise.all(Array.from({ length: 20 }, () => deliver(app, body, { eventId: 'evt_same_' + order.id })));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await metric(app, /payments_total\{outcome="paid",source="webhook"\} (\d+)/)).toBe(paidBefore + 1);
    const [event] = await dataSource(app, 'payments').query('SELECT deliveries FROM webhook_events WHERE event_id = ?', [
      'evt_same_' + order.id,
    ]);
    expect(event.deliveries).toBe(20);
    expect(await orderStatus(app, user, order.id)).toBe('paid');
  });

  it('a different event about the same payment (order.paid after payment.captured) is a no-op', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    const payment = fake.pay((await startPayment(app, user, order.id)).body.providerOrderId);

    expect((await deliver(app, webhookBody('payment.captured', payment)).expect(200)).body.outcome).toBe('paid');
    expect((await deliver(app, webhookBody('order.paid', payment)).expect(200)).body.outcome).toBe('duplicate');
  });

  it('a failed card, then a new attempt that succeeds', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    const first = (await startPayment(app, user, order.id)).body;
    const failed = fake.pay(first.providerOrderId, { status: 'failed' });
    expect((await deliver(app, webhookBody('payment.failed', failed)).expect(200)).body.outcome).toBe('failed');
    expect(await orderStatus(app, user, order.id)).toBe('pending_payment');

    // After a failure the next click gets a fresh provider order.
    const second = (await startPayment(app, user, order.id)).body;
    expect(second.providerOrderId).not.toBe(first.providerOrderId);
    await deliver(app, webhookBody('payment.captured', fake.pay(second.providerOrderId))).expect(200);
    expect(await orderStatus(app, user, order.id)).toBe('paid');

    // The old failure arriving again, late, doesn't undo anything.
    await deliver(app, webhookBody('payment.failed', failed)).expect(200);
    expect(await orderStatus(app, user, order.id)).toBe('paid');
  });

  it('a second payment for an already-paid order is refunded', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    const session = (await startPayment(app, user, order.id)).body;
    await deliver(app, webhookBody('payment.captured', fake.pay(session.providerOrderId))).expect(200);

    const extra = fake.pay(session.providerOrderId); // e.g. paid again in a second browser tab
    expect((await deliver(app, webhookBody('payment.captured', extra)).expect(200)).body.outcome).toBe('refund');
    expect(await paymentRow(app, extra.id)).toEqual({ status: 'refund_pending', refundReason: 'paid_twice' });

    await app.get(PaymentsService).sendPendingRefunds();
    expect(await paymentRow(app, extra.id)).toMatchObject({ status: 'refunded' });
    expect(fake.refunds.filter((r) => r.paymentId === extra.id)).toEqual([{ paymentId: extra.id, receipt: `rf_${extra.id}` }]);
  });

  it('a payment for the wrong amount is not accepted', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    const session = (await startPayment(app, user, order.id)).body;
    const wrong = fake.pay(session.providerOrderId, { amountPaise: 100 });

    expect((await deliver(app, webhookBody('payment.captured', wrong)).expect(200)).body.outcome).toBe('refund');
    expect(await orderStatus(app, user, order.id)).toBe('pending_payment');
    expect((await paymentRow(app, wrong.id)).refundReason).toBe('amount_mismatch');
  });

  it('a webhook for a provider order that is not ours is acknowledged and ignored', async () => {
    const stranger: GatewayPayment = {
      id: 'pay_stranger1',
      providerOrderId: 'order_notours1',
      amountPaise: 100,
      currency: 'INR',
      status: 'captured',
      errorCode: null,
      errorDescription: null,
    };
    expect((await deliver(app, webhookBody('payment.captured', stranger)).expect(200)).body.outcome).toBe('unknown_order');
    expect((await deliver(app, webhookBody('refund.processed', stranger)).expect(200)).body.outcome).toBe('ignored');
  });

  describe('the browser confirmation (Razorpay Checkout handler)', () => {
    const confirm = (user: TestUser, body: object, status = 200) =>
      http(app).post('/payments/razorpay/confirm').auth(user.accessToken, { type: 'bearer' }).send(body).expect(status);

    it('a valid signature + the provider saying captured → paid, before any webhook', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      const session = (await startPayment(app, user, order.id)).body;
      const payment = fake.pay(session.providerOrderId);
      const signature = signCheckout(session.providerOrderId, payment.id, TEST_PAYMENT_ENV.RAZORPAY_KEY_SECRET);

      const res = await confirm(user, { providerOrderId: session.providerOrderId, paymentId: payment.id, signature });
      expect(res.body).toEqual({ orderId: order.id, outcome: 'paid', orderStatus: 'paid' });

      // The webhook arriving afterwards is a repeat.
      expect((await deliver(app, webhookBody('payment.captured', payment)).expect(200)).body.outcome).toBe('duplicate');
    });

    it('rejects a forged signature, and hides other customers\' payments', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      const session = (await startPayment(app, user, order.id)).body;
      const payment = fake.pay(session.providerOrderId);
      const body = {
        providerOrderId: session.providerOrderId,
        paymentId: payment.id,
        signature: signCheckout(session.providerOrderId, payment.id, 'guessed-secret'),
      };

      await confirm(user, body, 400);
      await confirm(await registerUser(app), { ...body, signature: signCheckout(session.providerOrderId, payment.id, TEST_PAYMENT_ENV.RAZORPAY_KEY_SECRET) }, 404);
      expect(await orderStatus(app, user, order.id)).toBe('pending_payment');
    });

    it('when the provider is unreachable it answers "processing", and the webhook settles it', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      const session = (await startPayment(app, user, order.id)).body;
      const payment = fake.pay(session.providerOrderId);
      const signature = signCheckout(session.providerOrderId, payment.id, TEST_PAYMENT_ENV.RAZORPAY_KEY_SECRET);

      fake.down = true;
      const res = await confirm(user, { providerOrderId: session.providerOrderId, paymentId: payment.id, signature });
      expect(res.body).toMatchObject({ outcome: 'processing', orderStatus: 'pending_payment' });

      fake.down = false;
      await deliver(app, webhookBody('payment.captured', payment)).expect(200);
      expect(await orderStatus(app, user, order.id)).toBe('paid');
    });
  });

  describe('the redirect callback (Checkout with redirect: true, no pop-up)', () => {
    const callback = (orderId: string, form: Record<string, string>) =>
      http(app).post(`/payments/razorpay/callback?order=${orderId}`).type('form').send(form).expect(303);

    it('a signed success settles the order and sends the browser back to the demo page', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      const session = (await startPayment(app, user, order.id)).body;
      const payment = fake.pay(session.providerOrderId);

      const res = await callback(order.id, {
        razorpay_payment_id: payment.id,
        razorpay_order_id: session.providerOrderId,
        razorpay_signature: signCheckout(session.providerOrderId, payment.id, TEST_PAYMENT_ENV.RAZORPAY_KEY_SECRET),
      });

      expect(res.headers.location).toBe(`/demo/?order=${order.id}&payment=paid`);
      expect(await orderStatus(app, user, order.id)).toBe('paid');
    });

    it('a failure (error[...] fields) goes back with the reason; a forged signature changes nothing', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      const session = (await startPayment(app, user, order.id)).body;

      const failed = await callback(order.id, {
        'error[code]': 'BAD_REQUEST_ERROR',
        'error[description]': 'Payment failed',
        'error[metadata]': JSON.stringify({ order_id: session.providerOrderId }),
      });
      expect(failed.headers.location).toBe(`/demo/?order=${order.id}&payment=failed&reason=Payment+failed`);

      const payment = fake.pay(session.providerOrderId);
      const forged = await callback(order.id, {
        razorpay_payment_id: payment.id,
        razorpay_order_id: session.providerOrderId,
        razorpay_signature: signCheckout(session.providerOrderId, payment.id, 'guessed-secret'),
      });
      expect(forged.headers.location).toBe(`/demo/?order=${order.id}&payment=error`);
      expect(await orderStatus(app, user, order.id)).toBe('pending_payment');
    });

    it('never redirects anywhere but the demo page', async () => {
      const res = await callback('https://evil.example', { 'error[description]': 'x' });
      expect(res.headers.location).toBe('/demo/?order=&payment=failed&reason=x');
    });

    it('return=shop sends the browser to the shop\'s order page; anything else falls back to the demo page', async () => {
      const id = randomUUID();
      const shop = await http(app)
        .post(`/payments/razorpay/callback?order=${id}&return=shop`)
        .type('form')
        .send({ 'error[description]': 'declined' })
        .expect(303);
      expect(shop.headers.location).toBe(`/shop/orders/${id}?payment=failed&reason=declined`);

      const other = await http(app)
        .post(`/payments/razorpay/callback?order=${id}&return=https://evil.example`)
        .type('form')
        .send({ 'error[description]': 'x' })
        .expect(303);
      expect(other.headers.location).toBe(`/demo/?order=${id}&payment=failed&reason=x`);
    });
  });

  describe('the payment timeout job', () => {
    it('cancels an unpaid order and gives its stock back', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      await startPayment(app, user, order.id);
      const stockBefore = await available(app, productId);
      await ageOrder(app, order.id);

      await app.get(PaymentsService).expireOverdueOrders();

      expect(await orderStatus(app, user, order.id)).toBe('cancelled');
      expect(await reservationStatus(app, order.id)).toBe('released');
      expect(await available(app, productId)).toBe(stockBefore + 1);
      expect((await startPayment(app, user, order.id, 409)).body.error).toBe('order_cancelled');
    });

    it('finds a payment whose webhook never arrived, and keeps the order', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      fake.pay((await startPayment(app, user, order.id)).body.providerOrderId); // paid, webhook lost
      await ageOrder(app, order.id);

      const result = await app.get(PaymentsService).expireOverdueOrders();

      expect(result.paid).toBeGreaterThanOrEqual(1);
      expect(await orderStatus(app, user, order.id)).toBe('paid');
      expect(await reservationStatus(app, order.id)).toBe('committed');
    });

    it('does not cancel an order it could not check with the provider', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      await startPayment(app, user, order.id);
      await ageOrder(app, order.id);

      fake.down = true;
      await app.get(PaymentsService).expireOverdueOrders();
      expect(await orderStatus(app, user, order.id)).toBe('pending_payment');
    });

    it('a drop order that expires unpaid frees the customer to try that drop again', async () => {
      const productId2 = await createProduct(app, admin, { priceCents: 1299_00, stock: 5 });
      const drop = (
        await http(app)
          .post('/drops')
          .auth(admin.accessToken, { type: 'bearer' })
          .send({ productId: productId2, startsAt: new Date(Date.now() - 1000).toISOString(), admitPerSecond: 1000 })
          .expect(201)
      ).body;
      const user = await registerUser(app);
      const pass = async () =>
        (await http(app).post(`/drops/${drop.id}/queue`).auth(user.accessToken, { type: 'bearer' }).expect(200)).body.pass;
      const checkout = async () => {
        await http(app).put(`/cart/items/${productId2}`).auth(user.accessToken, { type: 'bearer' }).send({ quantity: 1 }).expect(200);
        return http(app).post('/checkout').auth(user.accessToken, { type: 'bearer' }).set('Idempotency-Key', randomUUID()).send({ dropPass: await pass() });
      };

      const first = await checkout();
      expect(first.status).toBe(201);
      expect((await checkout()).body.error).toBe('drop_already_bought'); // while the order is pending

      await ageOrder(app, first.body.id);
      await app.get(PaymentsService).expireOverdueOrders();

      expect(await orderStatus(app, user, first.body.id)).toBe('cancelled');
      expect((await checkout()).status).toBe(201); // didn't buy, so may try again
    });

    it('money that arrives after the order was cancelled is refunded, once', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      const session = (await startPayment(app, user, order.id)).body;
      await ageOrder(app, order.id);
      await app.get(PaymentsService).expireOverdueOrders();

      const late = fake.pay(session.providerOrderId);
      expect((await deliver(app, webhookBody('payment.captured', late)).expect(200)).body.outcome).toBe('refund');
      expect(await orderStatus(app, user, order.id)).toBe('cancelled');

      // Two refund rounds (or two workers): the provider sees one refund.
      await app.get(PaymentsService).sendPendingRefunds();
      await app.get(PaymentsService).sendPendingRefunds();
      expect(fake.refunds.filter((r) => r.paymentId === late.id)).toHaveLength(1);
      expect(await paymentRow(app, late.id)).toEqual({ status: 'refunded', refundReason: 'order_cancelled' });
    });

    it('a refund that fails is retried on the next round', async () => {
      const user = await registerUser(app);
      const order = await placeOrder(app, user, productId);
      const session = (await startPayment(app, user, order.id)).body;
      await deliver(app, webhookBody('payment.captured', fake.pay(session.providerOrderId))).expect(200);
      const extra = fake.pay(session.providerOrderId);
      await deliver(app, webhookBody('payment.captured', extra)).expect(200);

      fake.down = true;
      await app.get(PaymentsService).sendPendingRefunds();
      expect((await paymentRow(app, extra.id)).status).toBe('refund_pending');
      fake.down = false;
      await app.get(PaymentsService).sendPendingRefunds();
      expect((await paymentRow(app, extra.id)).status).toBe('refunded');
    });
  });

  it('refuses to open a payment for an order that is about to expire, or is someone else\'s', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    await startPayment(app, await registerUser(app), order.id, 404);
    await dataSource(app, 'orders').query(`UPDATE orders SET created_at = NOW(3) - INTERVAL 870 SECOND WHERE id = ?`, [order.id]);
    expect((await startPayment(app, user, order.id, 409)).body.error).toBe('payment_window_closed');
  });

  it('answers 502 when the provider is down at "Pay", and lets the customer retry', async () => {
    const user = await registerUser(app);
    const order = await placeOrder(app, user, productId);
    fake.down = true;
    expect((await startPayment(app, user, order.id, 502)).body.error).toBe('payment_provider_unavailable');
    fake.down = false;
    await startPayment(app, user, order.id, 201);
  });
});

describe('payments when Razorpay is not configured', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startApp('fastify');
  });
  afterAll(() => app.close());

  it('answers 503 instead of failing strangely; the shop still works', async () => {
    const admin = await registerAdmin(app);
    const user = await registerUser(app);
    const productId = await createProduct(app, admin, { stock: 5 });
    const order = await placeOrder(app, user, productId);

    await startPayment(app, user, order.id, 503);
    await deliver(app, '{"event":"payment.captured"}').expect(503);
  });
});
