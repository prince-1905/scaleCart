import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InventoryService } from '../inventory/inventory.service.js';
import { RabbitService } from '../messaging/rabbit.service.js';
import {
  PAYMENT_EVENTS,
  type OrderPaymentResult,
  type OrderPaymentResultEvent,
  type PaymentCapturedEvent,
} from '../messaging/topology.js';
import { MetricsService } from '../observability/metrics.service.js';
import { OrderLifecycle } from './order-lifecycle.js';

const MAX_ATTEMPTS = 12;
const ATTEMPT_HEADER = 'x-attempt';

/** A UUID-shaped id computed from the input: the same payment always gives the same reply-event id. */
function stableId(input: string): string {
  const h = createHash('sha256').update(input).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Phase 8: the payments service says "payment P took money for order X". The shop decides what that means for the
 * order, and answers with order.payment_result (runs in the worker).
 *
 * In ONE orders-DB transaction: the conditional UPDATE (pending_payment → paid; exactly one payment ever wins) and
 * the reply event in the outbox. Then the stock is committed (inventory DB). Every step is safe to repeat:
 * - markPaid again → 'already_paid' (or 'paid_by_other' / 'cancelled' again)
 * - the reply's id is derived from the payment id, so a redelivered message can't add a second reply
 * - inventory.commit is idempotent
 * So no inbox table is needed here: the order's state machine is the dedup (the payments side uses an inbox).
 */
@Injectable()
export class PaymentCapturedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentCapturedConsumer.name);

  constructor(
    @InjectDataSource('orders') private readonly db: DataSource,
    private readonly rabbit: RabbitService,
    private readonly lifecycle: OrderLifecycle,
    private readonly inventory: InventoryService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    void this.rabbit.start();
    await this.rabbit.consume(this.rabbit.names.shopPayments, 20, (msg, reply) => this.handle(msg, reply));
  }

  async handle(msg: ConsumeMessage, reply: { ack(): void; nack(requeue: boolean): void }): Promise<void> {
    let event: PaymentCapturedEvent;
    try {
      event = JSON.parse(msg.content.toString('utf8'));
      if (msg.properties.type !== PAYMENT_EVENTS.paymentCaptured || !event.orderId || !event.paymentId) {
        throw new Error('unknown event');
      }
    } catch {
      await this.forward(`${this.rabbit.names.shopPayments}.dlq`, msg, { 'x-failure-reason': 'unparseable' }, reply);
      this.metrics.paymentEvents.inc({ result: 'dead_lettered' });
      return;
    }

    try {
      const result = await this.apply(event);
      this.metrics.paymentEvents.inc({ result });
      // Time from "money captured" (the payments service wrote the event) to "order settled" here.
      if (msg.properties.timestamp) this.metrics.paymentSettleDelay.observe(Date.now() / 1000 - msg.properties.timestamp);
      reply.ack();
    } catch (err) {
      const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1);
      this.logger.warn(`payment ${event.paymentId} for order ${event.orderId}: attempt ${attempt} failed: ${(err as Error).message}`);
      const dead = attempt >= MAX_ATTEMPTS;
      const queue = `${this.rabbit.names.shopPayments}${dead ? '.dlq' : '.retry'}`;
      await this.forward(queue, msg, dead ? { 'x-failure-reason': (err as Error).message } : { [ATTEMPT_HEADER]: attempt + 1 }, reply);
      this.metrics.paymentEvents.inc({ result: dead ? 'dead_lettered' : 'retried' });
    }
  }

  /** Exposed for tests: settle one captured payment, return what happened to the order. */
  async apply(event: PaymentCapturedEvent): Promise<OrderPaymentResult> {
    const result = await this.db.transaction(async (m) => {
      const marked = await this.lifecycle.markPaid(event.orderId, event.paymentId, m);
      const outcome: OrderPaymentResult = marked === 'not_found' ? 'cancelled' : marked;
      const replyEvent: OrderPaymentResultEvent = { orderId: event.orderId, paymentId: event.paymentId, result: outcome };
      await m.query(
        `INSERT INTO outbox (id, event_type, aggregate_id, payload) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE id = id`,
        [stableId(`order.payment_result:${event.paymentId}`), PAYMENT_EVENTS.orderPaymentResult, event.orderId, JSON.stringify(replyEvent)],
      );
      return outcome;
    });
    if (result === 'paid' || result === 'already_paid') {
      // A repeat commits again on purpose: if the first run crashed before committing, this finishes it.
      await this.inventory.commit(event.orderId);
    }
    return result;
  }

  /** Copy to another queue, wait until RabbitMQ stored it, then ack the original (or requeue it if the copy failed). */
  private async forward(
    queue: string,
    msg: ConsumeMessage,
    headers: Record<string, unknown>,
    reply: { ack(): void; nack(requeue: boolean): void },
  ) {
    try {
      this.rabbit.sendToQueue(queue, msg.content, {
        messageId: msg.properties.messageId,
        type: msg.properties.type,
        contentType: msg.properties.contentType,
        timestamp: msg.properties.timestamp,
        headers: { ...msg.properties.headers, ...headers },
      });
      await this.rabbit.confirm();
      reply.ack();
    } catch {
      reply.nack(true);
    }
  }
}
