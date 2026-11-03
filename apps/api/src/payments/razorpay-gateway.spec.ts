import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError } from './payment-gateway.js';
import { parseRazorpayEvent, RazorpayGateway } from './razorpay-gateway.js';
import { signCheckout, signWebhook, verifyCheckoutSignature, verifyWebhookSignature } from './signatures.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RazorpayGateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates an order with basic auth, amount in paise and the receipt', async () => {
    const fetchMock = vi.fn(async () => json(200, { id: 'order_abc', amount: 2499, currency: 'INR' }));
    vi.stubGlobal('fetch', fetchMock);

    const order = await new RazorpayGateway('rzp_test_key', 'secret').createOrder({
      amountPaise: 2499,
      receipt: 'r-1',
      notes: { order_id: 'o1' },
    });

    expect(order).toEqual({ id: 'order_abc', amountPaise: 2499, currency: 'INR' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({ amount: 2499, currency: 'INR', receipt: 'r-1', notes: { order_id: 'o1' } });
  });

  it('sends no body on GET', async () => {
    const fetchMock = vi.fn(async () => json(200, { items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await new RazorpayGateway('k', 's').fetchOrderPayments('order_x');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/orders/order_x/payments');
    expect(init.body).toBeUndefined();
  });

  it("turns Razorpay's error body into a GatewayError with the description and status", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Order amount less than minimum' } })));
    const err = await new RazorpayGateway('k', 's').createOrder({ amountPaise: 1, receipt: 'r', notes: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Order amount less than minimum');
  });

  it('treats a duplicate refund receipt as "already refunded", not as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: { description: 'Duplicate receipt found' } })));
    expect(await new RazorpayGateway('k', 's').refund('pay_1', 'rf_pay_1')).toEqual({ refundId: null, alreadyRefunded: true });
  });

  it('reports a network failure as a GatewayError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(new RazorpayGateway('k', 's').fetchPayment('pay_1')).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('parseRazorpayEvent', () => {
  it('reads the payment entity of a payment event', () => {
    const parsed = parseRazorpayEvent({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_1', order_id: 'order_1', amount: 500, currency: 'INR', status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'declined' },
        },
      },
    });
    expect(parsed).toEqual({
      event: 'payment.failed',
      payment: { id: 'pay_1', providerOrderId: 'order_1', amountPaise: 500, currency: 'INR', status: 'failed', errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'declined' },
    });
  });

  it('an event without a payment gives payment: null; a non-event throws', () => {
    expect(parseRazorpayEvent({ event: 'refund.processed', payload: {} })).toEqual({ event: 'refund.processed', payment: null });
    expect(() => parseRazorpayEvent({ hello: 1 })).toThrow();
  });
});

describe('signatures', () => {
  it('webhook: valid only for the exact bytes and the right secret', () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const sig = signWebhook(body, 'whsec');
    expect(verifyWebhookSignature(body, sig, 'whsec')).toBe(true);
    expect(verifyWebhookSignature(Buffer.from('{"event": "payment.captured"}'), sig, 'whsec')).toBe(false);
    expect(verifyWebhookSignature(body, sig, 'other')).toBe(false);
    expect(verifyWebhookSignature(body, 'short', 'whsec')).toBe(false);
  });

  it('checkout: signs "<order_id>|<payment_id>" with the key secret', () => {
    const sig = signCheckout('order_1', 'pay_1', 'keysecret');
    expect(verifyCheckoutSignature('order_1', 'pay_1', sig, 'keysecret')).toBe(true);
    // Same payment presented for a different order: rejected.
    expect(verifyCheckoutSignature('order_2', 'pay_1', sig, 'keysecret')).toBe(false);
  });
});
