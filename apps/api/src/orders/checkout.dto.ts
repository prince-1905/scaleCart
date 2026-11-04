import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
