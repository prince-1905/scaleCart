import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { Internal } from '../common/auth.js';
import { UUID_PATTERN } from '../common/uuid.js';
import { ENV, type Env } from '../config/env.js';
import { SkipRateLimit } from '../rate-limit/rate-limit.js';
import { OrderLifecycle } from './order-lifecycle.js';

/**
 * Phase 8: what the payments service asks the shop, synchronously, when a customer clicks Pay.
 * Service token only (X-Service-Token); NGINX never routes /internal/*. Not rate-limited: every call comes
 * from the payments service's address, and it has its own timeout + circuit breaker.
 */
@Internal()
@SkipRateLimit()
@Controller('internal/orders')
export class InternalOrdersController {
  constructor(
    private readonly orders: OrderLifecycle,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get(':id')
  async get(@Param('id') id: string) {
    const order = UUID_PATTERN.test(id) ? await this.orders.get(id) : null;
    if (!order) throw new NotFoundException('order not found');
    return {
      id: order.id,
      userId: order.userId,
      status: order.status,
      totalCents: order.totalCents,
      // The shop owns the deadline; payments only reads it.
      payBy: new Date(new Date(order.createdAt).getTime() + this.env.paymentTimeoutSeconds * 1000).toISOString(),
    };
  }
}
