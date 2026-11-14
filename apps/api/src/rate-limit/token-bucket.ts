import { Injectable } from '@nestjs/common';
import { RedisService } from '../cache/redis.service.js';

/**
 * One token bucket per key, in one atomic step inside Redis.
 *
 * Nothing adds tokens on a timer. The bucket stores only "tokens left" and "when we last
 * looked"; each request first adds (time passed × refill rate), capped at the capacity, then
 * takes `cost` tokens if there are enough.
 *
 * - Time comes from Redis (TIME), not from the API pods, so pods with different clocks agree.
 * - If the clock steps back (this laptop's Docker VM does, every ~27 s), elapsed counts as 0.
 * - The key expires once the bucket would be full again: idle users cost no memory.
 *
 * KEYS: the bucket · ARGV: capacity, refill per second, cost
 * Returns { 1 = allowed / 0 = refused, whole tokens left, ms until `cost` tokens are back }
 */
const TAKE_SCRIPT = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)

local saved = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(saved[1])
local at = tonumber(saved[2])
if tokens == nil or at == nil then
  tokens = capacity
  at = now
end
tokens = math.min(capacity, tokens + math.max(0, now - at) * rate / 1000)

local allowed = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', now)
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity - tokens) * 1000 / rate) + 1000)
return { allowed, math.floor(tokens), wait }`;

export interface BucketSize {
  /** Most tokens the bucket holds: the largest burst allowed after being quiet. */
  capacity: number;
  /** Tokens added back per second: the steady speed allowed. */
  refillPerSecond: number;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  /** When refused: milliseconds until the request would be allowed. */
  retryAfterMs: number;
}

@Injectable()
export class TokenBucket {
  constructor(private readonly redis: RedisService) {}

  /** undefined = Redis couldn't answer (the guard then falls back to LocalTokenBucket). */
  async take(key: string, size: BucketSize, cost = 1): Promise<TakeResult | undefined> {
    const reply = await this.redis.tryRun('rate_limit', (r) =>
      r.eval(TAKE_SCRIPT, {
        keys: [key],
        arguments: [String(size.capacity), String(size.refillPerSecond), String(cost)],
      }),
    );
    if (!Array.isArray(reply)) return undefined;
    const [allowed, remaining, wait] = reply as number[];
    return { allowed: allowed === 1, remaining, retryAfterMs: wait };
  }
}

/** Buckets kept in one pod's memory at most; the oldest are dropped first. */
const LOCAL_MAX_BUCKETS = 10_000;

/**
 * The backup when Redis can't answer in time: the same token bucket, in this pod's memory.
 *
 * E9: under a flood the API was so busy that Redis replies came back after the 200 ms timeout,
 * and "fail open" then let 18,373 of the attacker's requests through. With this backup a slow or
 * down Redis means "each pod limits on its own" instead of "no limit at all".
 *
 * Trade-off: buckets aren't shared, so with N pods a caller can get up to N × the limit while
 * Redis is out. Still a limit; and nothing about money depends on it.
 */
export class LocalTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  take(key: string, size: BucketSize, cost = 1): TakeResult {
    const now = this.now();
    const saved = this.buckets.get(key);
    let tokens = size.capacity;
    if (saved) {
      tokens = Math.min(size.capacity, saved.tokens + (Math.max(0, now - saved.at) * size.refillPerSecond) / 1000);
      this.buckets.delete(key); // re-inserted below: Map order = least recently used first
    } else if (this.buckets.size >= LOCAL_MAX_BUCKETS) {
      this.buckets.delete(this.buckets.keys().next().value as string);
    }
    const allowed = tokens >= cost;
    if (allowed) tokens -= cost;
    this.buckets.set(key, { tokens, at: now });
    return {
      allowed,
      remaining: Math.floor(tokens),
      retryAfterMs: allowed ? 0 : Math.ceil(((cost - tokens) * 1000) / size.refillPerSecond),
    };
  }
}
