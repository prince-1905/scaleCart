import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per order.created event the email worker has taken on. 'sending' = claimed by one worker, email on its way;
 * 'sent' = done. The primary key on the event id is what lets only ONE copy of an event claim it (E17).
 */
@Entity({ name: 'sent_notifications' })
export class SentNotification {
  @PrimaryColumn({ name: 'event_id', type: 'char', length: 36 })
  eventId: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @Column({ type: 'varchar', length: 254 })
  recipient: string;

  @Column({ type: 'enum', enum: ['sending', 'sent'], default: 'sent' })
  status: 'sending' | 'sent';

  @Column({ name: 'claimed_at', type: 'datetime', precision: 3 })
  claimedAt: Date;

  @Column({ name: 'sent_at', type: 'datetime', precision: 3, nullable: true })
  sentAt: Date | null;
}
