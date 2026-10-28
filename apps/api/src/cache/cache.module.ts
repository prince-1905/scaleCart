import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { CacheService } from './cache.service.js';
import { RedisService } from './redis.service.js';

@Module({
  imports: [ObservabilityModule],
  providers: [RedisService, CacheService],
  exports: [RedisService, CacheService],
})
export class CacheModule {}
