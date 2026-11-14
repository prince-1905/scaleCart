import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** One item bought on its own ("Buy now"), without touching the cart. */
export class BuyNowDto {
  @IsInt()
  @Min(1)
  productId: number;

  @IsInt()
  @Min(1)
  @Max(100)
  quantity: number;
}

export class CheckoutDto {
  /**
   * The total the customer saw. If prices changed since, checkout refuses (409)
   * instead of silently charging a different amount.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotalCents?: number;

  /** The waiting-room pass (POST /drops/:id/queue), needed when the cart holds a drop product. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  dropPass?: string;

  /**
   * Buy only this item and leave the cart alone (the drop page's "Buy now").
   * Without it, checkout buys the whole cart.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyNowDto)
  buyNow?: BuyNowDto;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
