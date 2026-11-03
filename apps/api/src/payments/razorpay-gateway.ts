import {
  GatewayError,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayPaymentStatus,
  type PaymentGateway,
} from './payment-gateway.js';

const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 10_000;

interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: GatewayPaymentStatus;
  error_code?: string | null;
  error_description?: string | null;
}

/** Razorpay's REST API with plain fetch: four calls don't justify an SDK dependency. */
export class RazorpayGateway implements PaymentGateway {
  readonly provider = 'razorpay' as const;
  private readonly auth: string;

  constructor(
    readonly publicKey: string,
    keySecret: string,
  ) {
    this.auth = `Basic ${Buffer.from(`${publicKey}:${keySecret}`).toString('base64')}`;
  }

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder> {
    const order = await this.call<{ id: string; amount: number; currency: string }>('POST', '/orders', {
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes,
    });
    return { id: order.id, amountPaise: order.amount, currency: order.currency };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    return toPayment(await this.call<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`));
  }

  async fetchOrderPayments(providerOrderId: string): Promise<GatewayPayment[]> {
    const res = await this.call<{ items: RazorpayPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(providerOrderId)}/payments`,
    );
    return res.items.map(toPayment);
  }

  async refund(paymentId: string, receipt: string) {
    try {
      const r = await this.call<{ id: string }>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
        receipt,
      });
      return { refundId: r.id, alreadyRefunded: false };
    } catch (err) {
      // A repeat with the same receipt, or the payment is already fully refunded: the money is back either way.
      if (err instanceof GatewayError && err.status === 400 && /duplicate|fully refunded/i.test(err.message)) {
        return { refundId: null, alreadyRefunded: true };
      }
      throw err;
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { authorization: this.auth, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (method === 'POST') init.body = JSON.stringify(body ?? {});
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, init);
    } catch (err) {
      throw new GatewayError(`razorpay ${method} ${path}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // Razorpay errors look like {"error":{"code":"BAD_REQUEST_ERROR","description":"..."}}.
      let description = text.slice(0, 300);
      try {
        description = (JSON.parse(text) as { error?: { description?: string } }).error?.description ?? description;
      } catch {
        // not JSON: keep the raw text
      }
      throw new GatewayError(`razorpay ${method} ${path} → ${res.status}: ${description}`, res.status);
    }
    return JSON.parse(text) as T;
  }
}

/**
 * A Razorpay webhook body: `{ event: "payment.captured", payload: { payment: { entity: {...} } } }`.
 * payment.* and order.paid events carry the payment entity; we only need that.
 */
export function parseRazorpayEvent(body: unknown): { event: string; payment: GatewayPayment | null } {
  const b = body as { event?: unknown; payload?: { payment?: { entity?: RazorpayPayment } } } | null;
  if (!b || typeof b.event !== 'string') throw new Error('not a Razorpay event');
  const entity = b.payload?.payment?.entity;
  const valid =
    entity && typeof entity.id === 'string' && typeof entity.order_id === 'string' && Number.isInteger(entity.amount);
  return { event: b.event, payment: valid ? toPayment(entity) : null };
}

export function toPayment(p: RazorpayPayment): GatewayPayment {
  return {
    id: p.id,
    providerOrderId: p.order_id,
    amountPaise: p.amount,
    currency: p.currency,
    status: p.status,
    errorCode: p.error_code || null,
    errorDescription: p.error_description || null,
  };
}
