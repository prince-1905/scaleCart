import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** A fixed list, so filters and the AI assistant can rely on exact values. */
export const PRODUCT_CATEGORIES = [
  'electronics',
  'fashion',
  'footwear',
  'home',
  'kitchen',
  'beauty',
  'sports',
  'books',
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_SORTS = ['relevance', 'price_asc', 'price_desc', 'newest'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/**
 * Filtered search for shoppers (and the AI assistant). Unlike `list`, this returns one
 * page of best matches, not a cursor: sorting by price or relevance can't use the id keyset.
 */
export class SearchProductsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(PRODUCT_CATEGORIES)
  category?: ProductCategory;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;

  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort: ProductSort = 'relevance';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit: number = 10;
}

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

  @IsOptional()
  @IsIn(PRODUCT_CATEGORIES)
  category?: ProductCategory;

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
  @IsIn(PRODUCT_CATEGORIES)
  category?: ProductCategory;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  priceCents?: number;
}
