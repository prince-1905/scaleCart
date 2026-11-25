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
/** "Another copy is sending this right now": retried separately, never counted as a failed attempt. */
const BUSY_HEADER = 'x-busy';
/** 5 s apart: ~2.5 min. A claim older than CLAIM_STALE_SECONDS is taken over long before that. */
const MAX_BUSY_RETRIES = 30;
/**
 * A 'sending' claim older than this means its worker died mid-send: another copy may take it over. Longer than the
 * slowest possible send (mailer timeouts: 3 s connect + 3 s greeting + 10 s socket).
 */
export const CLAIM_STALE_SECONDS = 60;

/** Another copy of the same event holds a fresh claim: try again shortly (it may crash before sending). */
class ClaimedElsewhere extends Error {}

/**
 * Sends the order-confirmation email for every `order.created` event (runs in the worker).
 *
 * - Idempotent: RabbitMQ (and the outbox relay) may deliver the same event several times, even at the
 *   same moment. A copy first CLAIMS the event (INSERT with the event id as primary key: only one
 *   wins), sends, then marks it 'sent'. Copies that lose: 'sent' → skipped; 'sending' → retried
 *   in 5 s (the winner might crash). Send failed → the claim is released, so the retry can send.
 *   Before E17 it was check → send → record, and 10 copies at once sent up to 10 emails.
 *   One gap remains: a crash between "email sent" and "marked sent" sends it again once the claim
 *   is stale (CLAIM_STALE_SECONDS). With an outside system like SMTP you can make duplicates rare,
 *   not impossible ("at least once").
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
      if (err instanceof ClaimedElsewhere) {
        const busy = Number(msg.properties.headers?.[BUSY_HEADER] ?? 0) + 1;
        if (busy > MAX_BUSY_RETRIES) {
          await this.deadLetter(msg, 'claim never released', reply);
        } else {
          await this.forward(this.rabbit.names.notificationsRetry, msg, { [BUSY_HEADER]: busy }, reply);
          this.metrics.notifications.inc({ outcome: 'claimed_elsewhere' });
        }
        return;
      }
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
    // Cheap early exit for the common repeat (already sent), before any call to identity.
    if ((await this.statusOf(event.eventId)) === 'sent') {
      this.metrics.notifications.inc({ outcome: 'duplicate' });
      return;
    }

    // The event carries the address since E14b: no call to identity, so an identity outage can't lose this email.
    // Older events don't: ask identity (if it's down this throws, and the message is retried).
    const to = event.email ?? (await this.users.getEmail(event.userId));
    if (!to) {
      this.metrics.notifications.inc({ outcome: 'no_recipient' });
      return;
    }

    switch (await this.claim(event, to)) {
      case 'already_sent':
        this.metrics.notifications.inc({ outcome: 'duplicate' });
        return;
      case 'claimed_elsewhere':
        throw new ClaimedElsewhere(`order ${event.orderId}: another copy is sending`);
    }

    try {
      await this.mailer.sendOrderConfirmation({
        to,
        orderId: event.orderId,
        totalCents: event.totalCents,
        items: event.items,
      });
    } catch (err) {
      // Not sent: free the claim so this message's retry (or another copy) can send it.
      await this.db
        .query(`DELETE FROM sent_notifications WHERE event_id = ? AND status = 'sending'`, [event.eventId])
        .catch(() => {});
      throw err;
    }
    await this.db.query(`UPDATE sent_notifications SET status = 'sent', sent_at = NOW(3) WHERE event_id = ?`, [event.eventId]);
    this.metrics.notifications.inc({ outcome: 'sent' });
    this.metrics.notificationDelay.observe((Date.now() - Date.parse(event.occurredAt)) / 1000);
  }

  private async statusOf(eventId: string): Promise<'sending' | 'sent' | null> {
    const rows = (await this.db.query('SELECT status FROM sent_notifications WHERE event_id = ?', [eventId])) as { status: 'sending' | 'sent' }[];
    return rows[0]?.status ?? null;
  }

  /**
   * One atomic step decides who sends: the INSERT succeeds for exactly one copy (primary key = event id). A claim
   * left 'sending' for CLAIM_STALE_SECONDS belongs to a worker that died mid-send: taken over with a conditional UPDATE
   * (again only one copy can win it).
   */
  private async claim(event: OrderCreatedEvent, to: string): Promise<'claimed' | 'already_sent' | 'claimed_elsewhere'> {
    const inserted = (await this.db.query(
      `INSERT IGNORE INTO sent_notifications (event_id, order_id, recipient, status, claimed_at) VALUES (?, ?, ?, 'sending', NOW(3))`,
      [event.eventId, event.orderId, to],
    )) as { affectedRows: number };
    if (inserted.affectedRows === 1) return 'claimed';
    const takenOver = (await this.db.query(
      `UPDATE sent_notifications SET claimed_at = NOW(3), recipient = ?
        WHERE event_id = ? AND status = 'sending' AND claimed_at < NOW(3) - INTERVAL ? SECOND`,
      [to, event.eventId, CLAIM_STALE_SECONDS],
    )) as { affectedRows: number };
    if (takenOver.affectedRows === 1) return 'claimed';
    return (await this.statusOf(event.eventId)) === 'sent' ? 'already_sent' : 'claimed_elsewhere';
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
