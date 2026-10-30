import { Module } from '@nestjs/common';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { inventoryDatabase } from './inventory.database.js';
import { InventoryService } from './inventory.service.js';

/** Inventory's data and logic without HTTP; used by the API (via InventoryModule) and the worker. */
@Module({
  imports: [...moduleTypeOrm(inventoryDatabase)],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryCoreModule {}
