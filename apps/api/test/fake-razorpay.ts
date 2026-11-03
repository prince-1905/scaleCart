import { randomBytes } from 'node:crypto';
import {
  GatewayError,
  type GatewayOrder,
  type GatewayPayment,
  type PaymentGateway,
} from '../src/payments/payment-gateway.js';

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;

/**
 * A stand-in for Razorpay's API, in memory. Tests "pay" with it (as the customer would on
 * Razorpay's page), then deliver the webhook themselves: on time, late, twice, or never.
 */
export class FakeRazorpay implements PaymentGateway {
  readonly provider = 'razorpay' as const;
  readonly publicKey = 'rzp_test_e2e';
  /** When true, every call fails like an unreachable provider. */
  down = false;
  readonly orders = new Map<string, GatewayOrder & { receipt: string }>();
  readonly payments = new Map<string, GatewayPayment>();
  /** Refund calls that the provider accepted (one per receipt), in order. */
  readonly refunds: { paymentId: string; receipt: string }[] = [];

  async createOrder(input: { amountPaise: number; receipt: string }): Promise<GatewayOrder> {
    this.check();
    if ([...this.orders.values()].some((o) => o.receipt === input.receipt)) {
      throw new GatewayError('razorpay POST /orders → 400: Duplicate request', 400);
    }
    const order = { id: id('order'), amountPaise: input.amountPaise, currency: 'INR', receipt: input.receipt };
    this.orders.set(order.id, order);
    return order;
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    this.check();
    const p = this.payments.get(paymentId);
    if (!p) throw new GatewayError('razorpay GET /payments → 400: The id provided does not exist', 400);
    return { ...p };
  }

  async fetchOrderPayments(providerOrderId: string): Promise<GatewayPayment[]> {
    this.check();
    return [...this.payments.values()].filter((p) => p.providerOrderId === providerOrderId).map((p) => ({ ...p }));
  }

  async refund(paymentId: string, receipt: string) {
    this.check();
    if (this.refunds.some((r) => r.receipt === receipt)) return { refundId: null, alreadyRefunded: true };
    this.refunds.push({ paymentId, receipt });
    this.payments.get(paymentId)!.status = 'refunded';
    return { refundId: id('rfnd'), alreadyRefunded: false };
  }

  /** The customer pays on the provider's page. Returns the payment as the provider records it. */
  pay(
    providerOrderId: string,
    { status = 'captured', amountPaise }: { status?: 'captured' | 'failed' | 'authorized'; amountPaise?: number } = {},
  ): GatewayPayment {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new Error(`fake: no provider order ${providerOrderId}`);
    const payment: GatewayPayment = {
      id: id('pay'),
      providerOrderId,
      amountPaise: amountPaise ?? order.amountPaise,
      currency: 'INR',
      status,
      errorCode: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      errorDescription: status === 'failed' ? 'Payment failed because the card was declined' : null,
    };
    this.payments.set(payment.id, payment);
    return { ...payment };
  }

  private check() {
    if (this.down) throw new GatewayError('razorpay: connect ETIMEDOUT');
  }
}

/** A webhook body shaped like Razorpay's (payment.* events carry payload.payment.entity). */
export function webhookBody(event: string, p: GatewayPayment): string {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_test',
    event,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: p.id,
          entity: 'payment',
          amount: p.amountPaise,
          currency: p.currency,
          status: p.status,
          order_id: p.providerOrderId,
          method: 'card',
          captured: p.status === 'captured',
          error_code: p.errorCode,
          error_description: p.errorDescription,
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}
