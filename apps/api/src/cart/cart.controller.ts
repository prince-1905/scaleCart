import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Put } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { CurrentUser, type AuthUser } from '../common/auth.js';
import { CartService, MAX_QUANTITY_PER_LINE } from './cart.service.js';

class SetQuantityDto {
  @IsInt()
  @Min(0)
  @Max(MAX_QUANTITY_PER_LINE)
  quantity: number;
}

@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  view(@CurrentUser() user: AuthUser) {
    return this.cart.view(user.id);
  }

  @Put('items/:productId')
  async setQuantity(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: SetQuantityDto,
  ) {
    await this.cart.setQuantity(user.id, productId, dto.quantity);
    return this.cart.view(user.id);
  }

  @Delete()
  @HttpCode(204)
  async clear(@CurrentUser() user: AuthUser) {
    await this.cart.clear(user.id);
  }
}
