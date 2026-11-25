import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Public, Roles } from '../common/auth.js';
import {
  CreateProductDto,
  ListProductsQuery,
  SearchProductsQuery,
  UpdateProductDto,
} from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  @Public()
  @Get()
  list(@Query() query: ListProductsQuery) {
    return this.catalog.list(query);
  }

  /** X-Search-Source says who answered: opensearch, mysql, or mysql-fallback (OpenSearch failed). */
  @Public()
  @Get('search')
  async search(@Query() query: SearchProductsQuery, @Res({ passthrough: true }) res: unknown) {
    const { items, source } = await this.catalog.searchWithSource(query);
    this.adapterHost.httpAdapter.setHeader(res, 'x-search-source', source);
    return items;
  }

  /** The filter sidebar: how many results per category and price range, for the same search (Phase 12). */
  @Public()
  @Get('search/facets')
  facets(@Query() query: SearchProductsQuery) {
    return this.catalog.facets(query);
  }

  @Public()
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const product = await this.catalog.getPublic(id);
    if (!product) throw new NotFoundException('product not found');
    return product;
  }

  @Roles('admin')
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.catalog.create(dto);
  }

  @Roles('admin')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProductDto) {
    if (Object.keys(dto).length === 0) throw new BadRequestException('nothing to update');
    return this.catalog.update(id, dto);
  }
}
