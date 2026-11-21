import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ObservabilityModule } from '../observability/observability.module.js';
import { AuthGuard } from './auth.guard.js';
import { JwksKeys } from './jwks-keys.js';
import { UsersModule } from './users.module.js';

/**
 * What's left of identity in the shop since Phase 11: CHECKING access tokens. Logging in, users, refresh tokens and
 * 2FA live in the identity service (apps/identity), which alone can sign tokens. This module:
 *   - the global AuthGuard (RS256, identity's public keys via JwksKeys)
 *   - UserDirectory (UsersModule): users' emails, asked from identity over HTTP
 */
@Module({
  imports: [
    UsersModule,
    ObservabilityModule,
    // Verify only: no secret, no private key. Algorithm, issuer and audience pinned (never trust the token's "alg").
    JwtModule.register({
      verifyOptions: { algorithms: ['RS256'], issuer: 'scalecart', audience: 'scalecart-api' },
    }),
  ],
  providers: [JwksKeys, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [JwksKeys],
})
export class IdentityModule {}
