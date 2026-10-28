import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

/**
 * Shared auth vocabulary. The global guard lives in the identity module; every
 * other module only needs these decorators, so none of them depends on identity.
 */
export type Role = 'customer' | 'admin';

export interface AuthUser {
  id: string;
  role: Role;
}

export const IS_PUBLIC = 'auth:isPublic';
export const ROLES = 'auth:roles';

/** Every route requires a valid access token unless marked public ("secure by default"). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
