import { Module } from '@nestjs/common';
import { DropsCoreModule } from './drops-core.module.js';
import { DropsController } from './drops.controller.js';

@Module({
  imports: [DropsCoreModule],
  controllers: [DropsController],
})
export class DropsModule {}
