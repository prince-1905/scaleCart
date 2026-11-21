import { SetMetadata } from '@nestjs/common';

/**
 * Which bucket a route uses. Every route uses `default` unless marked otherwise.
 *   default   everything else (browsing, cart, orders…)            per user, or per IP when logged out
 *   auth      register, login, refresh: password guessing, sign-up spam  always per IP
 *   checkout  placing orders and starting payments: the expensive writes  per user
 */
export type RateLimitPolicy = 'default' | 'auth' | 'checkout';

export const RATE_LIMIT_POLICY = 'rateLimit:policy';
export const SKIP_RATE_LIMIT = 'rateLimit:skip';

export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT_POLICY, policy);

/** Health checks, metrics, provider webhooks and lab routes: never limited. */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
