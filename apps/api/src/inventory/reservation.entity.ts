import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type ReservationStatus = 'reserved' | 'released' | 'committed';

/**
 * Stock taken for one order line. Remembering *which order* took stock is what makes
 * reserve and release safe to repeat: a retry finds the row and does nothing twice.
 */
@Entity({ name: 'reservations' })
export class Reservation {
  @PrimaryColumn({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @PrimaryColumn({ name: 'product_id', type: 'int', unsigned: true })
  productId: number;

  @Column({ type: 'int', unsigned: true })
  quantity: number;

  @Column({ type: 'enum', enum: ['reserved', 'released', 'committed'], default: 'reserved' })
  status: ReservationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}
