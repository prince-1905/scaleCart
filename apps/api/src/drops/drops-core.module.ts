import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryCoreModule } from '../inventory/inventory-core.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { DropsDataModule } from './drop-purchases.js';
import { DropsService } from './drops.service.js';
import { StockGate } from './stock-gate.js';
import { WaitingRoom } from './waiting-room.js';

/** Drops and the waiting room without HTTP: checkout (orders module) uses DropsService. */
@Module({
  imports: [DropsDataModule, CatalogModule, InventoryCoreModule, CacheModule, ObservabilityModule],
  providers: [DropsService, WaitingRoom, StockGate],
  exports: [DropsService],
})
export class DropsCoreModule {}
