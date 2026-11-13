import { Controller, Get, Injectable, NotFoundException, Param, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { Roles } from '../common/auth.js';
import { UUID_PATTERN } from '../common/uuid.js';
import { UserDirectory } from '../identity/user-directory.js';
import { Order, OrderItem, type OrderStatus } from './order.entity.js';

const STATUSES = ['pending_payment', 'paid', 'cancelled'] as const;

class AdminOrdersQuery {
  @IsOptional()
  @IsIn(STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @Matches(UUID_PATTERN)
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}

/** Every customer's orders, for the shop's staff. Customers only ever see their own (OrdersService). */
@Injectable()
export class OrdersAdmin {
  constructor(@InjectDataSource('orders') private readonly db: DataSource) {}

  /** Newest first, keyset-paginated on the time-ordered UUIDv7 id (uses the primary key or ix_orders_status_created). */
  async list(query: AdminOrdersQuery) {
    const qb = this.db.getRepository(Order).createQueryBuilder('o').orderBy('o.id', 'DESC').limit(query.limit + 1);
    if (query.status) qb.andWhere('o.status = :status', { status: query.status });
    if (query.before) qb.andWhere('o.id < :before', { before: query.before });
    const rows = await qb.getMany();
    const items = rows.slice(0, query.limit).map((o) => ({
      id: o.id,
      userId: o.userId,
      status: o.status,
      totalCents: o.totalCents,
      paymentId: o.paymentId,
      createdAt: o.createdAt.toISOString(),
    }));
    return { items, nextBefore: rows.length > query.limit ? items[items.length - 1].id : null };
  }

  /** Orders and money per status: all time, and the last 24 hours. */
  async stats() {
    const rows: { status: OrderStatus; orders: string; totalCents: string | null; orders24h: string; totalCents24h: string | null }[] =
      await this.db.query(
        `SELECT status, COUNT(*) AS orders, SUM(total_cents) AS totalCents,
                SUM(created_at >= NOW(3) - INTERVAL 1 DAY) AS orders24h,
                SUM(IF(created_at >= NOW(3) - INTERVAL 1 DAY, total_cents, 0)) AS totalCents24h
           FROM orders GROUP BY status`,
      );
    const byStatus = Object.fromEntries(
      STATUSES.map((s) => {
        const r = rows.find((row) => row.status === s);
        return [s, { orders: Number(r?.orders ?? 0), totalCents: Number(r?.totalCents ?? 0), orders24h: Number(r?.orders24h ?? 0), totalCents24h: Number(r?.totalCents24h ?? 0) }];
      }),
    );
    return { byStatus };
  }

  async get(orderId: string) {
    const order = await this.db.getRepository(Order).findOneBy({ id: orderId });
    if (!order) return null;
    const items = await this.db.getRepository(OrderItem).find({ where: { orderId }, order: { productId: 'ASC' } });
    return {
      id: order.id,
      userId: order.userId,
      status: order.status,
      totalCents: order.totalCents,
      paymentId: order.paymentId,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      items: items.map(({ productId, sku, name, unitPriceCents, quantity }) => ({ productId, sku, name, unitPriceCents, quantity })),
    };
  }
}

@Roles('admin')
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(
    private readonly orders: OrdersAdmin,
    private readonly users: UserDirectory,
  ) {}

  @Get()
  async list(@Query() query: AdminOrdersQuery) {
    const page = await this.orders.list(query);
    const emails = await this.users.getEmails(page.items.map((o) => o.userId));
    return { ...page, items: page.items.map((o) => ({ ...o, email: emails.get(o.userId) ?? null })) };
  }

  @Get('stats')
  stats() {
    return this.orders.stats();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const order = UUID_PATTERN.test(id) ? await this.orders.get(id) : null;
    if (!order) throw new NotFoundException('order not found');
    return { ...order, email: await this.users.getEmail(order.userId) };
  }
}
