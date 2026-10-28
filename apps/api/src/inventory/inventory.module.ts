import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { InventoryController } from './inventory.controller.js';
import { inventoryDatabase } from './inventory.database.js';
import { InventoryService } from './inventory.service.js';

@Module({
  imports: [...moduleTypeOrm(inventoryDatabase), CatalogModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
