import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { CurrentUser, type AuthUser } from '../common/auth.js';
import { UUID_PATTERN } from '../common/uuid.js';
import { CheckoutDto, IDEMPOTENCY_KEY_PATTERN } from './checkout.dto.js';
import { CheckoutService } from './checkout.service.js';
import { OrdersService } from './orders.service.js';

class ListOrdersQuery {
  @IsOptional()
  @Matches(UUID_PATTERN)
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

@Controller()
export class OrdersController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly orders: OrdersService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  /**
   * Requires an `Idempotency-Key` header (e.g. a UUID the client creates once per
   * checkout attempt and reuses on every retry of it).
   */
  @Post('checkout')
  @HttpCode(201)
  async checkout(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CheckoutDto,
    @Res({ passthrough: true }) res: unknown,
  ) {
    if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException(
        'Idempotency-Key header is required: 8-128 characters of letters, digits, - or _',
      );
    }
    const result = await this.checkoutService.checkout(user.id, key, dto);
    if (result.replayed) {
      this.adapterHost.httpAdapter.setHeader(res, 'idempotent-replayed', 'true');
    }
    return result.order;
  }

  @Get('orders')
  list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersQuery) {
    return this.orders.list(user.id, query.limit, query.before);
  }

  @Get('orders/:id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = UUID_PATTERN.test(id) ? await this.orders.get(user.id, id) : null;
    if (!order) throw new NotFoundException('order not found');
    return order;
  }
}
