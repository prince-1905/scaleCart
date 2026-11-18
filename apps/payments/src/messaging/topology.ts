import type { Channel } from 'amqplib';

/**
 * Event names and queues shared by the shop and the payments service: a contract both copies must keep identical
 * (apps/api/src/messaging/topology.ts has the same names).
 *
 *   payment.captured      payments → shop    "this payment took money for order X"
 *   order.payment_result  shop → payments    "order X: paid | already_paid | paid_by_other | cancelled"
 */
export const EVENTS = {
  paymentCaptured: 'payment.captured',
  orderPaymentResult: 'order.payment_result',
} as const;

export interface PaymentCapturedEvent {
  orderId: string;
  paymentId: string;
  amountPaise: number;
}

export type OrderPaymentResult = 'paid' | 'already_paid' | 'paid_by_other' | 'cancelled';

export interface OrderPaymentResultEvent {
  orderId: string;
  paymentId: string;
  result: OrderPaymentResult;
}

export function topology(prefix: string) {
  return {
    events: `${prefix}scalecart.events`,
    /** Consumed by the shop's worker. */
    shopPayments: `${prefix}orders.payment-captured`,
    /** Consumed by this service. */
    paymentResults: `${prefix}payments.order-results`,
  };
}
export type Topology = ReturnType<typeof topology>;

export const RETRY_DELAY_MS = 5_000;

/** A queue with a 5 s retry queue and a dead-letter queue, the same shape the shop uses. Same arguments on both sides. */
async function consumerQueue(ch: Channel, exchange: string, queue: string, routingKey: string) {
  await ch.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.bindQueue(queue, exchange, routingKey);
  await ch.assertQueue(`${queue}.retry`, {
    durable: true,
    arguments: { 'x-message-ttl': RETRY_DELAY_MS, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
  });
  await ch.assertQueue(`${queue}.dlq`, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
}

/**
 * Declares the exchange, our own queue, AND the queue for the events we publish. A topic exchange drops a message
 * that no queue is bound for: if payments started before the shop had ever run, the first payment.captured events
 * would vanish. Declaring the consumer's queue here (identically) gives every event a place to wait.
 */
export async function assertTopology(ch: Channel, t: Topology): Promise<void> {
  await ch.assertExchange(t.events, 'topic', { durable: true });
  await consumerQueue(ch, t.events, t.paymentResults, EVENTS.orderPaymentResult);
  await consumerQueue(ch, t.events, t.shopPayments, EVENTS.paymentCaptured);
}
