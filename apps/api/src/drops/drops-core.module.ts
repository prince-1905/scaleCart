import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { InventoryCoreModule } from '../inventory/inventory-core.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { dropsDatabase } from './drops.database.js';
import { DropsService } from './drops.service.js';
import { WaitingRoom } from './waiting-room.js';

/** Drops and the waiting room without HTTP: checkout (orders module) uses DropsService. */
@Module({
  imports: [...moduleTypeOrm(dropsDatabase), CatalogModule, InventoryCoreModule, CacheModule, ObservabilityModule],
  providers: [DropsService, WaitingRoom],
  exports: [DropsService],
})
export class DropsCoreModule {}
