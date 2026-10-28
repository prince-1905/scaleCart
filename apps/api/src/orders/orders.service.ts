import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { OrderView } from './checkout.service.js';
import { Order, OrderItem } from './order.entity.js';

/** The orders module's read side: a customer's own orders only. */
@Injectable()
export class OrdersService {
  constructor(@InjectDataSource('orders') private readonly db: DataSource) {}

  /** Newest first, keyset-paginated on the time-ordered UUIDv7 id. */
  async list(userId: string, limit: number, before?: string) {
    const qb = this.db
      .getRepository(Order)
      .createQueryBuilder('o')
      .where('o.userId = :userId', { userId })
      .orderBy('o.id', 'DESC')
      .limit(limit + 1);
    if (before) qb.andWhere('o.id < :before', { before });

    const rows = await qb.getMany();
    const items = rows.slice(0, limit).map((o) => ({
      id: o.id,
      status: o.status,
      totalCents: o.totalCents,
      createdAt: o.createdAt.toISOString(),
    }));
    return { items, nextBefore: rows.length > limit ? items[items.length - 1].id : null };
  }

  async get(userId: string, orderId: string): Promise<OrderView | null> {
    // Filtering by user_id too: another customer's order id simply "doesn't exist".
    const order = await this.db.getRepository(Order).findOneBy({ id: orderId, userId });
    if (!order) return null;
    const items = await this.db
      .getRepository(OrderItem)
      .find({ where: { orderId }, order: { productId: 'ASC' } });
    return {
      id: order.id,
      status: order.status,
      totalCents: order.totalCents,
      items: items.map(({ productId, sku, name, unitPriceCents, quantity }) => ({
        productId,
        sku,
        name,
        unitPriceCents,
        quantity,
      })),
      createdAt: order.createdAt.toISOString(),
    };
  }
}
