import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { PRODUCT_CATEGORIES, type ProductCategory } from '../catalog/catalog.dto.js';

/** The facts the copy may use. The model is told to invent nothing beyond these. */
export class ProductCopyDto {
  @IsString()
  @Length(2, 200)
  name: string;

  @IsIn(PRODUCT_CATEGORIES)
  category: ProductCategory;

  /** Key facts: material, sizes, what's in the box… e.g. "breathable mesh, 280 g, sizes 6-11". */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
