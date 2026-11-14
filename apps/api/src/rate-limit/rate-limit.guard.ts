import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../common/auth.js';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';
import { RATE_LIMIT_POLICY, SKIP_RATE_LIMIT, type RateLimitPolicy } from './rate-limit.js';
import { LocalTokenBucket, TokenBucket } from './token-bucket.js';

interface HttpRequest {
  user?: AuthUser;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/**
 * API-wide rate limit: a token bucket per caller, stored in Redis, so every API replica shares it
 * (hitting another pod doesn't give you a fresh bucket).
 *
 * - Runs after the AuthGuard, so a logged-in caller is counted by user id: many shoppers behind one
 *   office/mobile IP don't share a bucket. Logged-out callers are counted by IP.
 * - A request with a bad token is refused by the AuthGuard (401) before it gets here. That costs one
 *   HMAC check, no database call.
 * - Refused: 429 + Retry-After (seconds), before any controller, database or Argon2 work.
 * - If Redis can't answer in time, this pod's own in-memory bucket decides (LocalTokenBucket).
 *   The first version let the request through instead ("fail open"), and under a flood that let
 *   the attacker in exactly when the API was busiest (E9). Nothing about money depends on it either
 *   way: stock and orders are protected by MySQL.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly local = new LocalTokenBucket();

  constructor(
    private readonly reflector: Reflector,
    private readonly bucket: TokenBucket,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.env.rateLimitEnabled || context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, targets)) return true;
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy>(RATE_LIMIT_POLICY, targets) ?? 'default';

    const req = context.switchToHttp().getRequest<HttpRequest>();
    const who = policy !== 'auth' && req.user ? `u:${req.user.id}` : `ip:${this.clientIp(req)}`;
    const size = this.env.rateLimits[policy];
    const key = `ratelimit:${policy}:${who}`;
    const shared = await this.bucket.take(key, size);
    const result = shared ?? this.local.take(key, size);
    this.metrics.rateLimit.inc({
      policy,
      result: result.allowed ? 'allowed' : 'limited',
      source: shared ? 'redis' : 'local',
    });
    if (result.allowed) return true;

    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    // Fastify's reply and Express's response both have header(name, value).
    context.switchToHttp().getResponse<{ header(name: string, value: string): unknown }>()
      .header('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'rate_limited',
        message: 'too many requests; slow down and try again shortly',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Behind NGINX every request comes from NGINX's address, so NGINX passes the real one in
   * X-Real-IP. Trusted only with TRUST_PROXY=true: without a proxy in front, a client could
   * send any X-Real-IP and get a fresh bucket each time.
   */
  private clientIp(req: HttpRequest): string {
    if (this.env.trustProxy) {
      const header = req.headers['x-real-ip'];
      const value = Array.isArray(header) ? header[0] : header;
      if (value) return value.trim();
    }
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
