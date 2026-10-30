import type { Channel } from 'amqplib';

/** Exchange and queue names. `prefix` keeps e2e tests apart from the dev stack. */
export function topology(prefix: string) {
  const notifications = `${prefix}notifications.order-created`;
  return {
    /** Topic exchange: publishers name an event ("order.created"), not a queue. */
    events: `${prefix}scalecart.events`,
    notifications,
    notificationsRetry: `${notifications}.retry`,
    notificationsDead: `${notifications}.dlq`,
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
}
