import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../cache/redis.service.js';
import { ENV, type Env } from '../config/env.js';

const WINDOW_SECONDS = 60;

/**
 * Limits chat messages per user per minute (AI_CHAT_PER_MINUTE).
 *
 * - Every message costs up to 5 model calls, and the provider's quota is shared by all
 *   users: one script hammering /ai/chat would otherwise use it up for everyone.
 * - Checked before calling the model, so refused messages cost nothing.
 * - Counter in Redis (shared by all API replicas), fixed one-minute window like LoginThrottle.
 * - Fails open: if Redis is down, chat is allowed.
 */
@Injectable()
export class ChatThrottle {
  private readonly max: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) env: Env,
  ) {
    this.max = env.aiChatPerMinute;
  }

  async assertAllowed(userId: string): Promise<void> {
    const key = `ai:chat:${userId}`;
    const reply = await this.redis.tryRun('incr', (r) =>
      r.multi().incr(key).expire(key, WINDOW_SECONDS, 'NX').ttl(key).exec(),
    );
    if (!reply) return;
    const [count, , ttl] = reply as unknown as [number, unknown, number];
    if (count > this.max) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'too_many_messages',
          message: `at most ${this.max} assistant messages per minute; try again shortly`,
          retryAfterSeconds: Math.max(ttl, 1),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
