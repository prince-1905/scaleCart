import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { UserDirectory } from '../identity/user-directory.js';
import { RabbitService } from '../messaging/rabbit.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { ORDER_CREATED, type OrderCreatedEvent } from '../orders/events.js';
import { MailerService } from './mailer.service.js';

/** 12 tries, 5 s apart ≈ 1 minute of mail-server trouble before a message is parked. */
export const MAX_ATTEMPTS = 12;
const PREFETCH = 20;
const ATTEMPT_HEADER = 'x-attempt';

/**
 * Sends the order-confirmation email for every `order.created` event (runs in the worker).
 *
 * - Idempotent: RabbitMQ (and the outbox relay) may deliver the same event twice. The
 *   event id is recorded in `sent_notifications` after sending; a repeat is skipped.
 *   One gap remains: a crash between "email sent" and "row saved" sends it twice. With an
 *   outside system like SMTP you can make duplicates rare, not impossible.
 * - Failures (mail server down) go to a retry queue and come back 5 s later; after
 *   MAX_ATTEMPTS they go to the dead-letter queue instead of looping forever.
 * - The message is acknowledged only after the work is done (or safely handed to the
 *   retry/dead-letter queue), so a crash mid-way means redelivery, never loss.
 */
@Injectable()
export class OrderCreatedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderCreatedConsumer.name);

  constructor(
    @InjectDataSource('notifications') private readonly db: DataSource,
    private readonly rabbit: RabbitService,
    private readonly mailer: MailerService,
    private readonly users: UserDirectory,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    void this.rabbit.start();
    await this.rabbit.consume(this.rabbit.names.notifications, PREFETCH, (msg, reply) =>
      this.handle(msg, reply),
    );
  }

  private async handle(msg: ConsumeMessage, reply: { ack(): void; nack(requeue: boolean): void }) {
    let event: OrderCreatedEvent;
    try {
      event = JSON.parse(msg.content.toString());
      if (msg.properties.type !== ORDER_CREATED || event.schemaVersion !== 1) throw new Error('unknown event');
    } catch {
      // A "poison" message will never succeed: park it right away.
      await this.deadLetter(msg, 'unparseable or unknown event', reply);
      return;
    }

    try {
      await this.process(event);
      reply.ack();
    } catch (err) {
      const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1);
      this.logger.warn(`order ${event.orderId}: email attempt ${attempt} failed: ${(err as Error).message}`);
      if (attempt >= MAX_ATTEMPTS) {
        await this.deadLetter(msg, (err as Error).message, reply);
      } else {
        await this.forward(this.rabbit.names.notificationsRetry, msg, { [ATTEMPT_HEADER]: attempt + 1 }, reply);
        this.metrics.notifications.inc({ outcome: 'retried' });
      }
    }
  }

  private async process(event: OrderCreatedEvent) {
    const done = await this.db.query('SELECT 1 FROM sent_notifications WHERE event_id = ?', [event.eventId]);
    if (done.length > 0) {
      this.metrics.notifications.inc({ outcome: 'duplicate' });
      return;
    }

    const to = await this.users.getEmail(event.userId);
    if (!to) {
      this.metrics.notifications.inc({ outcome: 'no_recipient' });
      return;
    }

    await this.mailer.sendOrderConfirmation({
      to,
      orderId: event.orderId,
      totalCents: event.totalCents,
      items: event.items,
    });
    await this.db.query(
      'INSERT IGNORE INTO sent_notifications (event_id, order_id, recipient) VALUES (?, ?, ?)',
      [event.eventId, event.orderId, to],
    );
    this.metrics.notifications.inc({ outcome: 'sent' });
    this.metrics.notificationDelay.observe((Date.now() - Date.parse(event.occurredAt)) / 1000);
  }

  private async deadLetter(msg: ConsumeMessage, reason: string, reply: { ack(): void; nack(requeue: boolean): void }) {
    await this.forward(this.rabbit.names.notificationsDead, msg, { 'x-failure-reason': reason }, reply);
    this.metrics.notifications.inc({ outcome: 'dead_lettered' });
  }

  /**
   * Copies the message to another queue, waits until RabbitMQ has stored the copy, and
   * only then acknowledges the original. If the copy fails, the original goes back to
   * the queue (nack + requeue): it's never dropped.
   */
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
