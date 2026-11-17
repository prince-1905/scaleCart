import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { ENV, type PaymentsEnv } from '../config/env.js';

export interface AuthUser {
  id: string;
  role: 'customer' | 'admin';
}

const IS_PUBLIC = 'auth:isPublic';
const INTERNAL = 'auth:internal';

/** No login needed (webhooks, the Razorpay redirect, health, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Only for the shop: needs the X-Service-Token header, never a customer's token. NGINX doesn't route /internal/*. */
export const Internal = () => SetMetadata(INTERNAL, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

/**
 * Global guard. Customers: the shop's access token (HS256, same secret, same issuer and audience). The shop
 * itself: the service token on /internal/* routes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly serviceToken: Buffer;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(ENV) env: PaymentsEnv,
  ) {
    this.serviceToken = Buffer.from(env.serviceToken);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest();

    if (this.reflector.getAllAndOverride<boolean>(INTERNAL, targets)) {
      const given = Buffer.from(String(req.headers['x-service-token'] ?? ''));
      if (given.length !== this.serviceToken.length || !timingSafeEqual(given, this.serviceToken)) {
        throw new UnauthorizedException('internal route: missing or wrong service token');
      }
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing bearer token');
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; role: AuthUser['role'] }>(token);
      req.user = { id: claims.sub, role: claims.role } satisfies AuthUser;
    } catch {
      throw new UnauthorizedException('invalid or expired access token');
    }
    return true;
  }
}
