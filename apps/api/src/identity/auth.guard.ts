import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC, ROLES, type AuthUser, type Role } from '../common/auth.js';
import type { AccessTokenClaims } from './auth.service.js';

/**
 * Global guard: checks the access token on every route not marked @Public().
 *
 * Verifying a JWT needs no database call: the signature proves we issued it. The
 * price: a token stays valid until it expires (15 min), even after logout or a role
 * change. Short access tokens + revocable refresh tokens keep that window small.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      // Public routes still note who's calling when a valid token comes along: the rate limit
      // counts logged-in shoppers by user id, not by their (often shared) IP (E9). A missing or
      // bad token is no error here: the route is public.
      if (typeof req.headers.authorization === 'string') {
        const [scheme, token] = req.headers.authorization.split(' ');
        if (scheme === 'Bearer' && token) {
          const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token).catch(() => undefined);
          if (claims) req.user = { id: claims.sub, role: claims.role } satisfies AuthUser;
        }
      }
      return true;
    }

    const header: string | undefined = req.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing bearer token');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch {
      throw new UnauthorizedException('invalid or expired access token');
    }

    const user: AuthUser = { id: claims.sub, role: claims.role };
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
