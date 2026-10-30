import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryCoreModule } from './inventory-core.module.js';
import { InventoryController } from './inventory.controller.js';

@Module({
  imports: [InventoryCoreModule, CatalogModule],
  controllers: [InventoryController],
  exports: [InventoryCoreModule],
})
export class InventoryModule {}
