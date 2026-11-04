import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/** A flash sale: one product goes on sale at `startsAt`, to a limited number of buyers per second. */
@Entity({ name: 'drops' })
export class Drop {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id: number;

  /** One drop per product (UNIQUE): checkout finds a product's drop by this. */
  @Column({ name: 'product_id', type: 'int', unsigned: true })
  productId: number;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'starts_at', type: 'datetime', precision: 3 })
  startsAt: Date;

  /** Units one customer may buy in this drop (one order). */
  @Column({ name: 'max_per_customer', type: 'tinyint', unsigned: true })
  maxPerCustomer: number;

  /** The waiting room lets this many tickets through per second after the start. */
  @Column({ name: 'admit_per_second', type: 'int', unsigned: true })
  admitPerSecond: number;

  /** Set: "one out, one in" with this many buyers shopping at once (admitPerSecond unused). Null: time-based. */
  @Column({ name: 'max_shoppers', type: 'int', unsigned: true, nullable: true })
  maxShoppers: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

/** "This customer bought in this drop": the per-customer limit, kept in MySQL so it's durable and exact. */
@Entity({ name: 'drop_purchases' })
export class DropPurchase {
  @PrimaryColumn({ name: 'drop_id', type: 'int', unsigned: true })
  dropId: number;

  @PrimaryColumn({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
