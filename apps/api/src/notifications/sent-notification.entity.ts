import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'sent_notifications' })
export class SentNotification {
  @PrimaryColumn({ name: 'event_id', type: 'char', length: 36 })
  eventId: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @Column({ type: 'varchar', length: 254 })
  recipient: string;

  @CreateDateColumn({ name: 'sent_at', type: 'datetime', precision: 3 })
  sentAt: Date;
}
