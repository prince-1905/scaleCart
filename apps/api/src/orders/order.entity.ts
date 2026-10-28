import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type OrderStatus = 'pending_payment' | 'paid' | 'cancelled';

@Entity({ name: 'orders' })
export class Order {
  /** UUIDv7, generated before stock is reserved so the reservation can name its order. */
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  @Column({ type: 'enum', enum: ['pending_payment', 'paid', 'cancelled'] })
  status: OrderStatus;

  @Column({ name: 'total_cents', type: 'int', unsigned: true })
  totalCents: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

/** Name and price are copied at checkout: later catalog edits must not rewrite old orders. */
@Entity({ name: 'order_items' })
export class OrderItem {
  @PrimaryColumn({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @PrimaryColumn({ name: 'product_id', type: 'int', unsigned: true })
  productId: number;

  @Column({ type: 'varchar', length: 64 })
  sku: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'unit_price_cents', type: 'int', unsigned: true })
  unitPriceCents: number;

  @Column({ type: 'int', unsigned: true })
  quantity: number;
}
