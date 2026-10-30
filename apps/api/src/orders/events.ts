/**
 * Events the orders module publishes. This is a public contract: other modules (and,
 * after the microservice split, other services) depend on it. Change it by adding
 * fields or a new version, never by renaming or removing.
 */
export const ORDER_CREATED = 'order.created';

export interface OrderCreatedEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  orderId: string;
  userId: string;
  totalCents: number;
  items: { productId: number; name: string; unitPriceCents: number; quantity: number }[];
}
