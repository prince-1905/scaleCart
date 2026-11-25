import type { Channel } from 'amqplib';

/**
 * Events shared with the payments service (Phase 8): a contract both copies must keep identical
 * (apps/payments/src/messaging/topology.ts has the same names and queue arguments).
 *   payment.captured      payments → shop    "this payment took money for order X"
 *   order.payment_result  shop → payments    "order X: paid | already_paid | paid_by_other | cancelled"
 */
export const PAYMENT_EVENTS = {
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

/** Exchange and queue names. `prefix` keeps e2e tests apart from the dev stack. */
export function topology(prefix: string) {
  const notifications = `${prefix}notifications.order-created`;
  return {
    /** Topic exchange: publishers name an event ("order.created"), not a queue. */
    events: `${prefix}scalecart.events`,
    notifications,
    notificationsRetry: `${notifications}.retry`,
    notificationsDead: `${notifications}.dlq`,
    /** Consumed by this worker. */
    shopPayments: `${prefix}orders.payment-captured`,
    /** Consumed by the payments service. */
    paymentResults: `${prefix}payments.order-results`,
    /** Phase 12: product.changed events for the search index (consumed by the worker's ProductIndexer). */
    searchProducts: `${prefix}search.product-changes`,
  };
}

export type Topology = ReturnType<typeof topology>;

/** A failed message waits this long in the retry queue before it is tried again. */
export const RETRY_DELAY_MS = 5_000;

/**
 * Declares everything (idempotent: re-declaring with the same settings is a no-op).
 *
 * order.created ──► notifications.order-created (quorum)
 *                      │ handler failed
 *                      ▼
 *                   ….retry (waits 5 s, then dead-letters back to the main queue)
 *                      │ failed too many times
 *                      ▼
 *                   ….dlq (parked for a human to inspect)
 */
export async function assertTopology(ch: Channel, t: Topology): Promise<void> {
  await ch.assertExchange(t.events, 'topic', { durable: true });

  // Quorum queue: replicated, durable, built for data safety (Raft). Here on one node,
  // but the same declaration works unchanged on a 3-node cluster.
  await ch.assertQueue(t.notifications, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await ch.bindQueue(t.notifications, t.events, 'order.created');

  // Delayed retry without a timer in our code: messages expire after 5 s and RabbitMQ
  // moves them back to the main queue (default exchange, routing key = queue name).
  await ch.assertQueue(t.notificationsRetry, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': t.notifications,
    },
  });

  await ch.assertQueue(t.notificationsDead, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });

  // Ours, and the payments service's: a topic exchange drops events no queue is bound for, so each side also
  // declares the queue of the events it publishes (identically), and an event always has a place to wait.
  await consumerQueue(ch, t.events, t.shopPayments, PAYMENT_EVENTS.paymentCaptured);
  await consumerQueue(ch, t.events, t.paymentResults, PAYMENT_EVENTS.orderPaymentResult);
  // Phase 12: the search index's copy of the catalog follows product changes.
  await consumerQueue(ch, t.events, t.searchProducts, 'product.changed');
}

/** A quorum queue with a 5 s retry queue and a dead-letter queue: the same arguments as in apps/payments. */
async function consumerQueue(ch: Channel, exchange: string, queue: string, routingKey: string) {
  await ch.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.bindQueue(queue, exchange, routingKey);
  await ch.assertQueue(`${queue}.retry`, {
    durable: true,
    arguments: { 'x-message-ttl': RETRY_DELAY_MS, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
  });
  await ch.assertQueue(`${queue}.dlq`, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
}
