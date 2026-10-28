import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ENV, type Env } from '../config/env.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { identityDatabase } from './identity.database.js';
import { PasswordHasher } from './password-hasher.js';

@Module({
  imports: [
    ...moduleTypeOrm(identityDatabase),
    ObservabilityModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.jwtSecret,
        // Pin the algorithm on both sides: a verifier that trusts the token's own
        // "alg" header can be tricked (e.g. "alg": "none").
        signOptions: {
          algorithm: 'HS256',
          expiresIn: env.accessTokenTtlSeconds,
          issuer: 'scalecart',
          audience: 'scalecart-api',
        },
        verifyOptions: { algorithms: ['HS256'], issuer: 'scalecart', audience: 'scalecart-api' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordHasher, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class IdentityModule {}
