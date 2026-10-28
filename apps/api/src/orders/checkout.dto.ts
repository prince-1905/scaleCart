import { IsInt, IsOptional, Min } from 'class-validator';

export class CheckoutDto {
  /**
   * The total the customer saw. If prices changed since, checkout refuses (409)
   * instead of silently charging a different amount.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotalCents?: number;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
