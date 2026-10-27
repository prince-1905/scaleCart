import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';

@Module({
  imports: [TerminusModule.forRoot()],
  controllers: [HealthController],
})
export class HealthModule {}
