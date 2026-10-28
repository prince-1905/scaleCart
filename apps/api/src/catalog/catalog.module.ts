import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { catalogDatabase } from './catalog.database.js';
import { CatalogService } from './catalog.service.js';
import { ProductsController } from './products.controller.js';

@Module({
  imports: [...moduleTypeOrm(catalogDatabase), CacheModule],
  controllers: [ProductsController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
