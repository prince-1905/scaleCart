import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Public, Roles } from '../common/auth.js';
import { CreateProductDto, ListProductsQuery } from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';

@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @Get()
  list(@Query() query: ListProductsQuery) {
    return this.catalog.list(query);
  }

  @Public()
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const product = await this.catalog.getById(id);
    if (!product) throw new NotFoundException('product not found');
    return product;
  }

  @Roles('admin')
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.catalog.create(dto);
  }
}
