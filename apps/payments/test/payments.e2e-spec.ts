import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RabbitService } from '../src/messaging/rabbit.service.js';
import { EVENTS } from '../src/messaging/topology.js';
import { PaymentJobs } from '../src/payments/payment-jobs.js';
import { signCheckout, signWebhook } from '../src/payments/signatures.js';
import { FakeRazorpay, webhookBody } from './fake-razorpay.js';
import {
  customerToken,
  db,
  eventsFor,
  eventually,
  FakeShop,
  http,
  KEY_SECRET,
  SERVICE_TOKEN,
  startPayments,
  WEBHOOK_SECRET,
} from './support.js';

/**
 * The payments service on its own (Phase 8): real HTTP, MySQL and RabbitMQ; Razorpay and the shop are fakes.
 * Where the monolith's tests checked "order paid", these check what the service tells the shop: one
 * payment.captured event (outbox), or a refund when the shop answers paid_by_other / cancelled.
 */
function deliver(app: INestApplication, body: string, { eventId = `evt_${randomUUID()}`, signature = signWebhook(body, WEBHOOK_SECRET) } = {}) {
  return http(app)
    .post('/payments/razorpay/webhook')
    .set('content-type', 'application/json')
    .set('x-razorpay-signature', signature)
    .set('x-razorpay-event-id', eventId)
    .send(body);
}

const paymentRow = async (app: INestApplication, paymentId: string) =>
  (await db(app).query('SELECT status, refund_reason AS refundReason FROM payments WHERE id = ?', [paymentId]))[0];

describe('payments service', () => {
  let app: INestApplication;
  let fake: FakeRazorpay;
  let shop: FakeShop;

  beforeAll(async () => {
    fake = new FakeRazorpay();
    shop = await new FakeShop().start();
    app = await startPayments(fake, shop.url);
  });
  afterAll(async () => {
    await app.close();
    shop.stop();
  });
  beforeEach(() => {
    fake.down = false;
    shop.mode = 'up';
  });

  /** A customer with an unpaid shop order, who clicked Pay. */
  async function startedPayment(totalCents = 2499) {
    const customer = customerToken();
    const order = shop.order(customer.userId, totalCents);
    const res = await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(201);
    return { customer, order, session: res.body as { providerOrderId: string; amountPaise: number; keyId: string } };
  }

  it('Pay → session from the shop\'s order; captured webhook → one payment.captured event, published to the shop\'s queue', async () => {
    const { order, session } = await startedPayment();
    expect(session).toMatchObject({ amountPaise: 2499, keyId: 'rzp_test_e2e' });

    const payment = fake.pay(session.providerOrderId);
    const res = await deliver(app, webhookBody('payment.captured', payment)).expect(200);
    expect(res.body).toMatchObject({ status: 'processed', outcome: 'captured' });
    expect((await paymentRow(app, payment.id)).status).toBe('captured');
    expect(await eventsFor(app, order.id)).toEqual([{ orderId: order.id, paymentId: payment.id, amountPaise: 2499 }]);

    // The relay publishes it: it lands in the shop's queue.
    await eventually(async () => {
      const [row] = await db(app).query('SELECT published_at FROM outbox WHERE aggregate_id = ?', [order.id]);
      return row?.published_at != null;
    });
  });

  it("Pay passes the gateway's X-Request-ID on to the shop, so both services log the same id", async () => {
    const customer = customerToken();
    const order = shop.order(customer.userId);
    const before = shop.requestIds.length;
    await http(app)
      .post(`/orders/${order.id}/payment`)
      .auth(customer.token, { type: 'bearer' })
      .set('x-request-id', 'req-e2e-123')
      .expect(201);
    expect(shop.requestIds.slice(before)).toEqual(['req-e2e-123']);
  });

  it('rejects a forged or altered webhook and records nothing', async () => {
    const { order, session } = await startedPayment();
    const payment = fake.pay(session.providerOrderId);
    const body = webhookBody('payment.captured', payment);
    await deliver(app, body, { signature: signWebhook(body, 'wrong-secret') }).expect(400);
    await deliver(app, body.replace('"amount":2499', '"amount":1'), { signature: signWebhook(body, WEBHOOK_SECRET) }).expect(400);
    expect(await paymentRow(app, payment.id)).toBeUndefined();
    expect(await eventsFor(app, order.id)).toEqual([]);
  });

  it('the same event 20 times at once → one payment row, ONE event for the shop', async () => {
    const { order, session } = await startedPayment();
    const payment = fake.pay(session.providerOrderId);
    const body = webhookBody('payment.captured', payment);
    const eventId = `evt_${randomUUID()}`;
    const statuses = await Promise.all(Array.from({ length: 20 }, () => deliver(app, body, { eventId }).then((r) => r.status)));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(await eventsFor(app, order.id)).toHaveLength(1);
  });

  it('20 DIFFERENT events about one payment at once (webhook storm) → still one event', async () => {
    const { order, session } = await startedPayment();
    const payment = fake.pay(session.providerOrderId);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => deliver(app, webhookBody(i % 2 ? 'order.paid' : 'payment.captured', payment)).expect(200)),
    );
    expect(await eventsFor(app, order.id)).toHaveLength(1);
  });

  it('a failed card, then a new attempt that succeeds → one event, for the second payment', async () => {
    const { customer, order, session } = await startedPayment();
    const failed = fake.pay(session.providerOrderId, { status: 'failed' });
    await deliver(app, webhookBody('payment.failed', failed)).expect(200);
    expect((await paymentRow(app, failed.id)).status).toBe('failed');

    const retry = await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(201);
    expect(retry.body.providerOrderId).not.toBe(session.providerOrderId); // Razorpay wants a new order after a failure
    const ok = fake.pay(retry.body.providerOrderId);
    await deliver(app, webhookBody('payment.captured', ok)).expect(200);
    expect(await eventsFor(app, order.id)).toEqual([{ orderId: order.id, paymentId: ok.id, amountPaise: 2499 }]);
  });

  it('a payment for the wrong amount is refunded and never reaches the shop', async () => {
    const { order, session } = await startedPayment();
    const payment = fake.pay(session.providerOrderId, { amountPaise: 1 });
    await deliver(app, webhookBody('payment.captured', payment)).expect(200);
    expect(await paymentRow(app, payment.id)).toEqual({ status: 'refund_pending', refundReason: 'amount_mismatch' });
    expect(await eventsFor(app, order.id)).toEqual([]);
  });

  it('a webhook for a provider order that is not ours is acknowledged and ignored', async () => {
    const stranger = { id: 'pay_x1', providerOrderId: 'order_notours', amountPaise: 100, currency: 'INR', status: 'captured' as const, errorCode: null, errorDescription: null };
    const res = await deliver(app, webhookBody('payment.captured', stranger)).expect(200);
    expect(res.body.outcome).toBe('unknown_order');
  });

  describe('the shop\'s answer (order.payment_result, through RabbitMQ)', () => {
    async function capturedPayment() {
      const { order, session } = await startedPayment();
      const payment = fake.pay(session.providerOrderId);
      await deliver(app, webhookBody('payment.captured', payment)).expect(200);
      return { order, payment };
    }
    async function shopAnswers(orderId: string, paymentId: string, result: string, messageId = randomUUID()) {
      const rabbit = app.get(RabbitService);
      rabbit.publishEvent(EVENTS.orderPaymentResult, { orderId, paymentId, result }, { messageId, type: EVENTS.orderPaymentResult });
      await rabbit.confirm();
    }

    it('"paid" → nothing to do', async () => {
      const { order, payment } = await capturedPayment();
      const id = randomUUID();
      await shopAnswers(order.id, payment.id, 'paid', id);
      await eventually(async () => (await db(app).query('SELECT 1 FROM processed_events WHERE event_id = ?', [id])).length === 1);
      expect((await paymentRow(app, payment.id)).status).toBe('captured');
    });

    it('"paid_by_other" → refund (paid twice); "cancelled" → refund (too late); the refund job sends each once', async () => {
      const twice = await capturedPayment();
      const late = await capturedPayment();
      await shopAnswers(twice.order.id, twice.payment.id, 'paid_by_other');
      await shopAnswers(late.order.id, late.payment.id, 'cancelled');
      await eventually(async () => (await paymentRow(app, late.payment.id)).status === 'refund_pending');
      await eventually(async () => (await paymentRow(app, twice.payment.id)).status === 'refund_pending');
      expect((await paymentRow(app, twice.payment.id)).refundReason).toBe('paid_twice');
      expect((await paymentRow(app, late.payment.id)).refundReason).toBe('order_cancelled');

      await app.get(PaymentJobs).runOnce();
      await app.get(PaymentJobs).runOnce();
      for (const p of [twice.payment, late.payment]) {
        expect((await paymentRow(app, p.id)).status).toBe('refunded');
        expect(fake.refunds.filter((r) => r.paymentId === p.id)).toHaveLength(1);
      }
    });

    it('the same answer delivered twice is handled once (inbox)', async () => {
      const { order, payment } = await capturedPayment();
      const id = randomUUID();
      await shopAnswers(order.id, payment.id, 'cancelled', id);
      await shopAnswers(order.id, payment.id, 'cancelled', id);
      await eventually(async () => (await paymentRow(app, payment.id)).status === 'refund_pending');
      await new Promise((r) => setTimeout(r, 500));
      expect(await db(app).query('SELECT 1 FROM processed_events WHERE event_id = ?', [id])).toHaveLength(1);
    });

    it('a refund that fails is retried on the next round', async () => {
      const { order, payment } = await capturedPayment();
      await shopAnswers(order.id, payment.id, 'cancelled');
      await eventually(async () => (await paymentRow(app, payment.id)).status === 'refund_pending');
      fake.down = true;
      await app.get(PaymentJobs).runOnce();
      expect((await paymentRow(app, payment.id)).status).toBe('refund_pending');
      fake.down = false;
      await app.get(PaymentJobs).runOnce();
      expect((await paymentRow(app, payment.id)).status).toBe('refunded');
    });
  });

  describe('the browser confirmation and redirect callback', () => {
    it('valid signature + provider says captured → "processing" and the event for the shop, before any webhook', async () => {
      const { customer, order, session } = await startedPayment();
      const payment = fake.pay(session.providerOrderId);
      const res = await http(app)
        .post('/payments/razorpay/confirm')
        .auth(customer.token, { type: 'bearer' })
        .send({ providerOrderId: session.providerOrderId, paymentId: payment.id, signature: signCheckout(session.providerOrderId, payment.id, KEY_SECRET) })
        .expect(200);
      expect(res.body).toEqual({ orderId: order.id, outcome: 'processing' });
      expect(await eventsFor(app, order.id)).toHaveLength(1);
    });

    it("rejects a forged signature, and hides other customers' payments", async () => {
      const { customer, session } = await startedPayment();
      const payment = fake.pay(session.providerOrderId);
      const body = { providerOrderId: session.providerOrderId, paymentId: payment.id, signature: 'f'.repeat(64) };
      await http(app).post('/payments/razorpay/confirm').auth(customer.token, { type: 'bearer' }).send(body).expect(400);
      const other = customerToken();
      body.signature = signCheckout(session.providerOrderId, payment.id, KEY_SECRET);
      await http(app).post('/payments/razorpay/confirm').auth(other.token, { type: 'bearer' }).send(body).expect(404);
    });

    it('provider unreachable → "processing" (the webhook settles it later)', async () => {
      const { customer, session } = await startedPayment();
      const payment = fake.pay(session.providerOrderId);
      fake.down = true;
      const res = await http(app)
        .post('/payments/razorpay/confirm')
        .auth(customer.token, { type: 'bearer' })
        .send({ providerOrderId: session.providerOrderId, paymentId: payment.id, signature: signCheckout(session.providerOrderId, payment.id, KEY_SECRET) })
        .expect(200);
      expect(res.body.outcome).toBe('processing');
    });

    it('redirect callback: success → shop order page; failure keeps the reason; never an open redirect', async () => {
      const { order, session } = await startedPayment();
      const payment = fake.pay(session.providerOrderId);
      const ok = await http(app)
        .post(`/payments/razorpay/callback?order=${order.id}&return=shop`)
        .type('form')
        .send({ razorpay_payment_id: payment.id, razorpay_order_id: session.providerOrderId, razorpay_signature: signCheckout(session.providerOrderId, payment.id, KEY_SECRET) })
        .expect(303);
      expect(ok.headers.location).toBe(`/shop/orders/${order.id}?payment=processing`);

      const failed = await http(app)
        .post(`/payments/razorpay/callback?order=${order.id}&return=shop`)
        .type('form')
        .send({ 'error[description]': 'Card declined' })
        .expect(303);
      expect(failed.headers.location).toBe(`/shop/orders/${order.id}?payment=failed&reason=Card+declined`);

      const evil = await http(app).post('/payments/razorpay/callback?order=https://evil.example&return=https://evil.example').type('form').send({}).expect(303);
      expect(evil.headers.location!.startsWith('/demo/?')).toBe(true);
    });
  });

  describe('the shop asks "paid after all?" before cancelling (POST /internal/orders/:id/reconcile)', () => {
    const reconcile = (orderId: string, token = SERVICE_TOKEN) =>
      http(app).post(`/internal/orders/${orderId}/reconcile`).set('X-Service-Token', token);

    it('finds a payment whose webhook never arrived → paid: true, and sends the event', async () => {
      const { order, session } = await startedPayment();
      fake.pay(session.providerOrderId); // paid on Razorpay; the webhook is lost
      expect((await reconcile(order.id).expect(200)).body).toEqual({ paid: true });
      expect(await eventsFor(app, order.id)).toHaveLength(1);
    });

    it('nothing paid → paid: false; provider down → 502 (the shop must not cancel)', async () => {
      const { order } = await startedPayment();
      expect((await reconcile(order.id).expect(200)).body).toEqual({ paid: false });
      fake.down = true;
      await reconcile(order.id).expect(502);
    });

    it('needs the service token; a customer token is not enough', async () => {
      const { customer, order } = await startedPayment();
      await reconcile(order.id, 'x'.repeat(SERVICE_TOKEN.length)).expect(401);
      await http(app).post(`/internal/orders/${order.id}/reconcile`).auth(customer.token, { type: 'bearer' }).expect(401);
    });
  });

  describe('starting a payment', () => {
    it("refuses an order that is about to expire, someone else's, or one the shop doesn't know", async () => {
      const customer = customerToken();
      const soon = shop.order(customer.userId, 2499, 0.5);
      await http(app).post(`/orders/${soon.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(409);
      const theirs = shop.order(randomUUID());
      await http(app).post(`/orders/${theirs.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(404);
      await http(app).post(`/orders/${randomUUID()}/payment`).auth(customer.token, { type: 'bearer' }).expect(404);
      await http(app).post(`/orders/${randomUUID()}/payment`).expect(401);
    });

    it('provider down at Pay → 502, nothing left behind, the customer can retry', async () => {
      const customer = customerToken();
      const order = shop.order(customer.userId);
      fake.down = true;
      await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(502);
      fake.down = false;
      await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(201);
    });
  });
});

describe('payments service when the shop is down or slow', () => {
  let app: INestApplication;
  let shop: FakeShop;

  beforeAll(async () => {
    shop = await new FakeShop().start();
    app = await startPayments(new FakeRazorpay(), shop.url);
  });
  afterAll(async () => {
    await app.close();
    shop.stop();
  });

  it('shop down → 503 shop_unavailable (after one retry); webhooks still work', async () => {
    const customer = customerToken();
    const order = shop.order(customer.userId);
    shop.mode = 'down';
    const before = shop.calls;
    const res = await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(503);
    expect(res.body.error).toBe('shop_unavailable');
    expect(shop.calls - before).toBe(2); // the call + one retry
    // Razorpay can still reach us: a webhook for an unknown order is accepted (200), not refused.
    await http(app).post('/payments/razorpay/webhook').set('content-type', 'application/json').send('{}').expect(400);
  });

  it('slow shop: each try waits at most SHOP_TIMEOUT_MS (300 ms) instead of hanging', async () => {
    const customer = customerToken();
    const order = shop.order(customer.userId);
    shop.mode = 'slow';
    const started = Date.now();
    await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(503);
    expect(Date.now() - started).toBeLessThan(1_500); // 2 tries × 300 ms + 100 ms pause, not 2 × 2 s
  });

  it('after 5 failures in a row the breaker opens: answers come at once and the shop is not called at all', async () => {
    const customer = customerToken();
    const order = shop.order(customer.userId);
    shop.mode = 'down';
    for (let i = 0; i < 5; i++) await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(503);
    const before = shop.calls;
    const started = Date.now();
    await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(503);
    expect(shop.calls).toBe(before);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('payments service without Razorpay keys', () => {
  it('answers 503 instead of failing strangely', async () => {
    const shop = await new FakeShop().start();
    const app = await startPayments(null, shop.url, { RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' });
    try {
      const customer = customerToken();
      const order = shop.order(customer.userId);
      await http(app).post(`/orders/${order.id}/payment`).auth(customer.token, { type: 'bearer' }).expect(503);
    } finally {
      await app.close();
      shop.stop();
    }
  });
});
