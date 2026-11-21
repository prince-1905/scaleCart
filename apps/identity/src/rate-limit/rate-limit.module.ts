import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CacheModule } from '../cache/cache.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { TokenBucket } from './token-bucket.js';

/**
 * Global guard. Imported after IdentityModule in AppModule, so it runs after the AuthGuard
 * and can count logged-in callers by user id (the e2e test checks this order).
 */
@Module({
  imports: [CacheModule, ObservabilityModule],
  providers: [TokenBucket, { provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class RateLimitModule {}
