import { Module } from '@nestjs/common';
import { LabController } from './lab.controller.js';

@Module({
  controllers: [LabController],
})
export class LabModule {}
