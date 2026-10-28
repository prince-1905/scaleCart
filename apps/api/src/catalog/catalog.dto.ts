import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

export class ListProductsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Keyset cursor: return products with id greater than this (the previous page's nextAfter). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class CreateProductDto {
  @Matches(/^[A-Za-z0-9-]{3,64}$/)
  sku: string;

  @IsString()
  @Length(1, 200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description: string = '';

  @IsInt()
  @Min(1)
  @Max(100_000_000)
  priceCents: number;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  priceCents?: number;
}
