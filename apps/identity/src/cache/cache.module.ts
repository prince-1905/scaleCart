import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { RedisService } from './redis.service.js';

/** Redis for login throttling and rate limits (no product cache in this service). */
@Module({
  imports: [ObservabilityModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class CacheModule {}
