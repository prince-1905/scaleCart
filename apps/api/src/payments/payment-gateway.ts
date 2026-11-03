/**
 * What the shop needs from a payment provider. Only razorpay-gateway.ts knows it's
 * Razorpay; tests swap in a fake, and another provider would be one new class.
 * Amounts are in paise (the smallest unit), like everywhere else in the shop.
 */
export interface PaymentGateway {
  readonly provider: 'razorpay';
  /** Public key the browser needs to open the provider's checkout. Not a secret. */
  readonly publicKey: string;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  /** Every payment attempt made against one provider order (failed ones too). */
  fetchOrderPayments(providerOrderId: string): Promise<GatewayPayment[]>;
  /**
   * Full refund. `receipt` makes it safe to repeat: the provider refuses a second refund
   * with the same receipt, which we report as `alreadyRefunded`.
   */
  refund(paymentId: string, receipt: string): Promise<{ refundId: string | null; alreadyRefunded: boolean }>;
}

export interface GatewayOrder {
  id: string;
  amountPaise: number;
  currency: string;
}

/** created/authorized = in progress, captured = money taken, failed = attempt over, refunded = given back. */
export type GatewayPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';

export interface GatewayPayment {
  id: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  status: GatewayPaymentStatus;
  errorCode: string | null;
  errorDescription: string | null;
}

/** The provider was unreachable, too slow, or answered with an error. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
