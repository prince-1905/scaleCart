import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'stock' })
export class Stock {
  @PrimaryColumn({ name: 'product_id', type: 'int', unsigned: true })
  productId: number;

  /** Units that can still be sold. UNSIGNED: MySQL itself refuses to store a negative. */
  @Column({ type: 'int', unsigned: true })
  available: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}
