import { Module } from '@nestjs/common';
import { DropsCoreModule } from './drops-core.module.js';
import { DropsController } from './drops.controller.js';
import { StockGateReset } from './stock-gate-reset.js';

@Module({
  imports: [DropsCoreModule],
  controllers: [DropsController],
  // In the API only: the worker has no drops module.
  providers: [StockGateReset],
})
export class DropsModule {}
