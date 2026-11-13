import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Put,
  Query,
} from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { CatalogService } from '../catalog/catalog.service.js';
import { Public, Roles } from '../common/auth.js';
import { InventoryService } from './inventory.service.js';

class SetStockDto {
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  available: number;
}

@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly catalog: CatalogService,
  ) {}

  /** Stock of up to 100 products at once: `?productIds=1,2,3`. Public, like a single product's stock. */
  @Public()
  @Get()
  async many(@Query('productIds') productIds = '') {
    const ids = [...new Set(productIds.split(',').map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length > 100) throw new BadRequestException('at most 100 productIds');
    const stock = await this.inventory.getAvailableMany(ids);
    return { items: [...stock].map(([productId, available]) => ({ productId, available })) };
  }

  @Public()
  @Get(':productId')
  async get(@Param('productId', ParseIntPipe) productId: number) {
    const available = await this.inventory.getAvailable(productId);
    if (available === null) throw new NotFoundException('no stock record for this product');
    return { productId, available };
  }

  @Roles('admin')
  @Put(':productId')
  @HttpCode(200)
  async set(@Param('productId', ParseIntPipe) productId: number, @Body() dto: SetStockDto) {
    if (!(await this.catalog.getById(productId))) throw new NotFoundException('product not found');
    await this.inventory.setAvailable(productId, dto.available);
    return { productId, available: dto.available };
  }
}
