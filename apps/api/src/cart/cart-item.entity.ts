import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'cart_items' })
export class CartItem {
  @PrimaryColumn({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  @PrimaryColumn({ name: 'product_id', type: 'int', unsigned: true })
  productId: number;

  @Column({ type: 'int', unsigned: true })
  quantity: number;

  @CreateDateColumn({ name: 'added_at', type: 'datetime', precision: 3 })
  addedAt: Date;
}
