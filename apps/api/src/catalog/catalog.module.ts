import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { ProductSearchIndex } from './search/product-search-index.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { catalogDatabase } from './catalog.database.js';
import { CatalogService } from './catalog.service.js';
import { ProductsController } from './products.controller.js';

@Module({
  imports: [...moduleTypeOrm(catalogDatabase), CacheModule, ObservabilityModule],
  controllers: [ProductsController],
  providers: [CatalogService, ProductSearchIndex],
  exports: [CatalogService, ProductSearchIndex],
})
export class CatalogModule {}
