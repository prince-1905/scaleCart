import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { isDuplicateKey } from '../database/database.js';
import { RabbitService } from '../messaging/rabbit.service.js';
import { EVENTS, type OrderPaymentResultEvent } from '../messaging/topology.js';
import { MetricsService } from '../observability/metrics.service.js';
import { PaymentsService } from './payments.service.js';

const MAX_ATTEMPTS = 5;

/**
 * Consumes the shop's order.payment_result events.
 *
 * Inbox: the event id goes into processed_events in the SAME transaction as the work, so a redelivered event
 * (RabbitMQ delivers at least once) finds its id and is skipped. A failure → retry queue (5 s); after 5 tries → DLQ.
 */
@Injectable()
export class PaymentEvents implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentEvents.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly rabbit: RabbitService,
    private readonly payments: PaymentsService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    await this.rabbit.consume(this.rabbit.names.paymentResults, 20, (msg, reply) => this.handle(msg, reply));
  }

  async handle(msg: ConsumeMessage, reply: { ack(): void; nack(requeue: boolean): void }): Promise<void> {
    const type = EVENTS.orderPaymentResult;
    const eventId = String(msg.properties.messageId ?? '');
    try {
      const event = JSON.parse(msg.content.toString('utf8')) as OrderPaymentResultEvent;
      if (!eventId || !event.orderId || !event.paymentId || !event.result) throw new Error('malformed event');
      const fresh = await this.db.transaction(async (m) => {
        try {
          await m.query('INSERT INTO processed_events (event_id, event_type) VALUES (?, ?)', [eventId, type]);
        } catch (err) {
          if (isDuplicateKey(err)) return false;
          throw err;
        }
        await this.payments.onOrderPaymentResult(event, m);
        return true;
      });
      this.metrics.events.inc({ direction: 'in', type, result: fresh ? event.result : 'duplicate' });
      reply.ack();
    } catch (err) {
      const attempts = Number(msg.properties.headers?.['x-attempts'] ?? 0) + 1;
      this.logger.warn(`${type} ${eventId} failed (attempt ${attempts}): ${(err as Error).message}`);
      const queue = this.rabbit.names.paymentResults;
      const dead = attempts >= MAX_ATTEMPTS;
      this.rabbit.sendToQueue(dead ? `${queue}.dlq` : `${queue}.retry`, msg.content, {
        ...msg.properties,
        headers: { ...msg.properties.headers, 'x-attempts': attempts },
      });
      await this.rabbit.confirm();
      this.metrics.events.inc({ direction: 'in', type, result: dead ? 'dead_lettered' : 'retried' });
      reply.ack();
    }
  }
}
