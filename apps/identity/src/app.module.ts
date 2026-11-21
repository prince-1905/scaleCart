import { DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from './cache/cache.module.js';
import { ENV, type Env } from './config/env.js';
import { CONNECTION, mysqlOptions } from './database/database.js';
import { HealthController } from './health/health.controller.js';
import { AuthController } from './identity/auth.controller.js';
import { AuthGuard } from './identity/auth.guard.js';
import { AuthService } from './identity/auth.service.js';
import { InternalUsersController, JwksController } from './identity/keys.controller.js';
import { LoginThrottle } from './identity/login-throttle.js';
import { PasswordHasher } from './identity/password-hasher.js';
import { RefreshToken } from './identity/refresh-token.entity.js';
import { TwoFactorController } from './identity/two-factor.controller.js';
import { TwoFactorService } from './identity/two-factor.service.js';
import { User } from './identity/user.entity.js';
import { SigningKeys } from './keys/signing-keys.js';
import { loggerModule } from './observability/logger.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';

/** The global auth guard, in its own module so it can be imported BEFORE the rate limiter (guards run in order). */
@Module({ providers: [{ provide: APP_GUARD, useClass: AuthGuard }] })
class AuthGuardModule {}

/**
 * The identity service (Phase 11): register, login (+2FA), refresh, logout, /auth/me, 2FA settings, the public keys
 * (JWKS) and the shop's email lookups. Its only database is scalecart_identity; Redis for login throttling and rate
 * limits. It is the only service holding the private key that signs access tokens.
 */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    const keys = new SigningKeys(env);
    return {
      module: AppModule,
      global: true,
      imports: [
        loggerModule(env),
        ObservabilityModule,
        CacheModule,
        TypeOrmModule.forRoot({ name: CONNECTION, ...mysqlOptions(env.db), retryAttempts: 5, retryDelay: 2_000 }),
        TypeOrmModule.forFeature([User, RefreshToken], CONNECTION),
        JwtModule.register({
          global: true,
          // RS256: signed with the private key (here only), checked with the public key (everywhere). The algorithm is
          // pinned on both sides: a verifier that trusts the token's own "alg" header can be tricked ("alg": "none").
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          signOptions: {
            algorithm: 'RS256',
            keyid: keys.kid,
            expiresIn: env.accessTokenTtlSeconds,
            issuer: 'scalecart',
            audience: 'scalecart-api',
          },
          verifyOptions: { algorithms: ['RS256'], issuer: 'scalecart', audience: 'scalecart-api' },
        }),
        AuthGuardModule,
        // After the auth guard, so the rate limit can count logged-in callers by user id.
        RateLimitModule,
      ],
      controllers: [AuthController, TwoFactorController, JwksController, InternalUsersController, HealthController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: SigningKeys, useValue: keys },
        AuthService,
        PasswordHasher,
        LoginThrottle,
        TwoFactorService,
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        },
      ],
      exports: [ENV, SigningKeys],
    };
  }
}
