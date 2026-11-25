import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { RabbitService } from '../src/messaging/rabbit.service.js';
import { MailerService } from '../src/notifications/mailer.service.js';
import { CLAIM_STALE_SECONDS } from '../src/notifications/order-created.consumer.js';
import { ORDER_CREATED, type OrderCreatedEvent } from '../src/orders/events.js';
import { dataSource, eventually, mailpitCount, startWorker } from './support.js';

/**
 * E17: the email worker claims an event before sending, so copies of the same event can't all send. Own queue prefix:
 * other test files' workers never take these messages (the "fail once" test relies on THIS worker's mailer).
 */
describe('order emails: one per order, even when copies arrive together (E17)', () => {
  let worker: INestApplication;

  const newEvent = (): OrderCreatedEvent => ({
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    orderId: randomUUID(),
    userId: randomUUID(),
    email: `e17-${randomUUID().slice(0, 8)}@test.local`,
    totalCents: 100,
    items: [{ productId: 1, name: 'claim test item', unitPriceCents: 100, quantity: 1 }],
  });
  const publish = async (event: OrderCreatedEvent, copies = 1) => {
    const rabbit = worker.get(RabbitService);
    for (let i = 0; i < copies; i++) rabbit.publishEvent(ORDER_CREATED, event, { messageId: event.eventId, type: ORDER_CREATED });
    await rabbit.confirm();
  };
  const emails = (event: OrderCreatedEvent) => mailpitCount(`Order ${event.orderId}`);
  const row = async (event: OrderCreatedEvent) =>
    ((await dataSource(worker, 'notifications').query('SELECT status FROM sent_notifications WHERE event_id = ?', [event.eventId])) as { status: string }[])[0];

  beforeAll(async () => {
    worker = await startWorker({ MQ_PREFIX: 'test-email.' });
  });
  afterAll(async () => {
    await worker?.close();
  });

  it('10 copies of the same event at the same moment → exactly 1 email', async () => {
    const event = newEvent();
    await publish(event, 10);
    await eventually(async () => (await emails(event)) >= 1);
    await sleep(2_000); // time for any extra copy to send
    expect(await emails(event)).toBe(1);
    expect((await row(event)).status).toBe('sent');
  });

  it('the first send fails → the claim is released → the retry sends it', async () => {
    const mailer = worker.get(MailerService);
    const send = vi.spyOn(mailer, 'sendOrderConfirmation').mockRejectedValueOnce(new Error('mail server down'));
    try {
      const event = newEvent();
      await publish(event);
      // The retry comes back after 5 s. If the failed attempt had left its claim "sending", the retry would have to
      // wait for it to go stale (60 s) and this would time out.
      await eventually(async () => (await emails(event)) === 1, 15_000);
      // Only this event's attempts: the queue may still deliver leftovers from earlier runs meanwhile.
      expect(send.mock.calls.filter(([mail]) => mail.orderId === event.orderId)).toHaveLength(2);
      expect((await row(event)).status).toBe('sent');
    } finally {
      send.mockRestore();
    }
  });

  it('a fresh claim held elsewhere → no email yet (retried, not dropped); once stale it is taken over → 1 email', async () => {
    const event = newEvent();
    // Another worker claimed this event and is "sending" (or crashed while sending).
    await dataSource(worker, 'notifications').query(
      `INSERT INTO sent_notifications (event_id, order_id, recipient, status, claimed_at) VALUES (?, ?, ?, 'sending', NOW(3))`,
      [event.eventId, event.orderId, event.email],
    );
    await publish(event);
    await sleep(2_500);
    expect(await emails(event)).toBe(0);

    // That worker never finished: make its claim old. The message is still around (in the retry queue) and takes over.
    await dataSource(worker, 'notifications').query(
      'UPDATE sent_notifications SET claimed_at = NOW(3) - INTERVAL ? SECOND WHERE event_id = ?',
      [CLAIM_STALE_SECONDS + 1, event.eventId],
    );
    await eventually(async () => (await emails(event)) === 1, 15_000);
    expect((await row(event)).status).toBe('sent');
  });
});
