import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { INTERNAL, IS_PUBLIC, ROLES, type AuthUser, type Role } from '../common/auth.js';
import { ENV, type Env } from '../config/env.js';
import { SigningKeys } from '../keys/signing-keys.js';
import type { AccessTokenClaims } from './auth.service.js';

/**
 * Global guard of the identity service. Same rules as the shop's: every route needs an access token unless
 * @Public(); /internal/* needs the service token. Tokens are checked with OUR public keys (by `kid`), so a token
 * signed with an older key that is still accepted (rotation) passes too.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly keys: SigningKeys,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest();

    if (this.reflector.getAllAndOverride<boolean>(INTERNAL, targets)) {
      const expected = Buffer.from(this.env.internalServiceToken);
      const given = Buffer.from(String(req.headers['x-service-token'] ?? ''));
      if (expected.length === 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new UnauthorizedException('internal route: missing or wrong service token');
      }
      return true;
    }

    const header: string | undefined = req.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    if (isPublic) {
      // Public routes still note who's calling when a valid token comes along (rate limits count users, not IPs).
      if (scheme === 'Bearer' && token) {
        const claims = await this.verify(token).catch(() => undefined);
        if (claims) req.user = { id: claims.sub, role: claims.role } satisfies AuthUser;
      }
      return true;
    }
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing bearer token');

    let claims: AccessTokenClaims;
    try {
      claims = await this.verify(token);
    } catch {
      throw new UnauthorizedException('invalid or expired access token');
    }
    const user: AuthUser = { id: claims.sub, role: claims.role };
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }

  private async verify(token: string): Promise<AccessTokenClaims> {
    const kid = (this.jwt.decode(token, { complete: true }) as { header?: { kid?: string } } | null)?.header?.kid;
    const publicKey = this.keys.publicKeyFor(kid);
    if (!publicKey) throw new Error('unknown key id');
    // Algorithm, issuer and audience pinned by the module's verifyOptions (RS256 only: never trust the token's "alg").
    return this.jwt.verifyAsync<AccessTokenClaims>(token, { publicKey });
  }
}
