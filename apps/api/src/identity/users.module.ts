import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { UserDirectory } from './user-directory.js';

/**
 * Users' emails from the identity service (HTTP, Phase 11). The worker (confirmation emails) and the admin order
 * pages import this; neither has access to identity's database any more.
 */
@Module({
  imports: [ObservabilityModule],
  providers: [UserDirectory],
  exports: [UserDirectory],
})
export class UsersModule {}
