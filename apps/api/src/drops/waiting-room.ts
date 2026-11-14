import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { RedisService } from '../cache/redis.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { DropPassSigner } from './drop-pass.js';

/** A called ticket gets a pass valid this long: enough to check out, too short to resell. */
export const PASS_TTL_MS = 5 * 60_000;
/** The line opens this long before the drop starts. */
export const PREQUEUE_MS = 10 * 60_000;
/** Tickets are forgotten a day after they were handed out. */
const TICKET_TTL_SECONDS = 24 * 3600;

/**
 * Gives a user their ticket in one atomic step: their existing number if they have one,
 * otherwise the next number. Refreshing the page or opening ten tabs can't jump the line.
 */
const TICKET_SCRIPT = `
local t = redis.call('GET', KEYS[1])
if t then return tonumber(t) end
t = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], t, 'EX', ARGV[1])
return t`;

/** "One out, one in" mode: a called buyer holds a place for this long, unless they finish sooner. */
export const SHOPPER_LEASE_MS = 60_000;

/**
 * "One out, one in": like a club bouncer, call the next tickets only while fewer than
 * `maxShoppers` called buyers are still shopping. A place frees up when a buyer finishes
 * checkout (release) or their 60 s lease runs out (they left). Runs atomically in Redis,
 * on whichever replica gets the request.
 *
 * KEYS: user ticket, ticket counter, called-up-to, active places (ZSET ticket → lease end), finished count
 * ARGV: ticket TTL s, now ms, startsAt ms, maxShoppers, lease ms
 * Returns: { ticket, calledUpTo, leaseEnd (0 = not your turn), finished, active }
 */
const WINDOW_SCRIPT = `
local t = tonumber(redis.call('GET', KEYS[1]))
if not t then
  t = redis.call('INCR', KEYS[2])
  redis.call('SET', KEYS[1], t, 'EX', ARGV[1])
end
local now = tonumber(ARGV[2])
local called = tonumber(redis.call('GET', KEYS[3]) or '0')
if now >= tonumber(ARGV[3]) then
  redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
  local free = tonumber(ARGV[4]) - redis.call('ZCARD', KEYS[4])
  local issued = tonumber(redis.call('GET', KEYS[2]) or '0')
  while free > 0 and called < issued do
    called = called + 1
    redis.call('ZADD', KEYS[4], now + tonumber(ARGV[5]), called)
    free = free - 1
  end
  redis.call('SET', KEYS[3], called)
  -- Called earlier but the lease ran out (came back late): back in if a place is free right now.
  if t <= called and not redis.call('ZSCORE', KEYS[4], t) and free > 0 then
    redis.call('ZADD', KEYS[4], now + tonumber(ARGV[5]), t)
  end
end
local lease = redis.call('ZSCORE', KEYS[4], t)
return { t, called, lease and tonumber(lease) or 0, tonumber(redis.call('GET', KEYS[5]) or '0'), redis.call('ZCARD', KEYS[4]) }`;

export interface DropTiming {
  id: number;
  startsAt: Date;
  admitPerSecond: number;
  /** Set = "one out, one in" mode with this many places; null = time-based (admitPerSecond). */
  maxShoppers: number | null;
}

export interface QueueStatus {
  dropId: number;
  ticket: number;
  /** Tickets up to this number have been called. */
  admittedUpTo: number;
  /** Tickets still in front of you (0 once yours is called). */
  position: number;
  /** Rough wait in seconds: time until the start, plus your place in line at the admit rate. */
  etaSeconds: number;
  admitted: boolean;
  /** Present once admitted: send it with the checkout. */
  pass?: string;
  passExpiresAt?: string;
  /** Nothing left to try for: the line is closed (no ticket is handed out). */
  soldOut?: boolean;
}

/**
 * How many tickets have been called at `now`. Pure arithmetic on the clock, so every API
 * replica agrees without talking to each other, and no background job is needed:
 * the line moves at `admitPerSecond`, starting at the drop's start time.
 */
export function admittedUpTo(drop: DropTiming, now: number): number {
  const elapsed = now - drop.startsAt.getTime();
  return elapsed <= 0 ? 0 : Math.floor((elapsed / 1000) * drop.admitPerSecond);
}

/**
 * The virtual waiting room, like a bank's token machine: a burst of buyers takes numbers
 * instead of all hitting checkout at once; numbers are called at the rate checkout can serve.
 */
@Injectable()
export class WaitingRoom {
  private readonly signer: DropPassSigner;

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    @Inject(ENV) env: Env,
  ) {
    this.signer = new DropPassSigner(env.jwtSecret);
  }

  /** Takes a ticket (or returns the one this user already has) and reports where they stand. */
  async join(drop: DropTiming, userId: string, now = Date.now()): Promise<QueueStatus> {
    if (drop.maxShoppers !== null) return this.joinWindow(drop, drop.maxShoppers, userId, now);
    const ticket = await this.redis.tryRun('drop_ticket', (r) =>
      r.eval(TICKET_SCRIPT, {
        keys: [userKey(drop.id, userId), seqKey(drop.id)],
        arguments: [String(TICKET_TTL_SECONDS)],
      }),
    );
    if (typeof ticket !== 'number') throw this.unavailable();
    return this.status(drop, userId, ticket, now);
  }

  /** A called buyer finished (bought, or sold out): free their place for the next ticket. */
  async release(dropId: number, ticket: number): Promise<void> {
    // Fail open: if Redis can't be reached, the place frees itself when the lease ends.
    await this.redis.tryRun('drop_release', async (r) => {
      const removed = await r.zRem(activeKey(dropId), String(ticket));
      if (removed > 0) await r.incr(finishedKey(dropId));
    });
  }

  private async joinWindow(drop: DropTiming, maxShoppers: number, userId: string, now: number): Promise<QueueStatus> {
    const reply = await this.redis.tryRun('drop_ticket', (r) =>
      r.eval(WINDOW_SCRIPT, {
        keys: [userKey(drop.id, userId), seqKey(drop.id), calledKey(drop.id), activeKey(drop.id), finishedKey(drop.id)],
        arguments: [
          String(TICKET_TTL_SECONDS),
          String(now),
          String(drop.startsAt.getTime()),
          String(maxShoppers),
          String(SHOPPER_LEASE_MS),
        ],
      }),
    );
    if (!Array.isArray(reply)) throw this.unavailable();
    const [ticket, calledUpTo, leaseEnd, finished] = reply.map(Number);
    const position = leaseEnd > 0 ? 0 : Math.max(0, ticket - calledUpTo);
    // Speed of the line so far: finished buyers per second since the start (at least 1/s for the estimate).
    const elapsed = Math.max(1, (now - drop.startsAt.getTime()) / 1000);
    const perSecond = Math.max(1, finished / elapsed);
    const untilStart = Math.max(0, drop.startsAt.getTime() - now) / 1000;
    const result: QueueStatus = {
      dropId: drop.id,
      ticket,
      admittedUpTo: calledUpTo,
      position,
      etaSeconds: Math.ceil(untilStart + position / perSecond),
      admitted: leaseEnd > 0,
    };
    if (leaseEnd > 0) {
      // The pass lasts exactly as long as the place: no pass outlives its place at the counter.
      result.pass = this.signer.sign({ d: drop.id, u: userId, t: ticket, exp: leaseEnd });
      result.passExpiresAt = new Date(leaseEnd).toISOString();
      this.metrics.dropQueue.inc({ result: 'admitted' });
    } else {
      this.metrics.dropQueue.inc({ result: 'waiting' });
    }
    return result;
  }

  private unavailable() {
    // Fail closed: without tickets there's no fair line, so the drop pauses. Stock is in
    // MySQL, so Redis being down can delay a drop but never oversell it.
    this.metrics.dropQueue.inc({ result: 'unavailable' });
    return new ServiceUnavailableException({
      statusCode: 503,
      error: 'waiting_room_unavailable',
      message: 'the waiting room is unavailable; try again in a few seconds',
    });
  }

  /** Where this ticket stands at `now`, with a pass if it has been called. */
  status(drop: DropTiming, userId: string, ticket: number, now = Date.now()): QueueStatus {
    const upTo = admittedUpTo(drop, now);
    const admitted = ticket <= upTo;
    const position = admitted ? 0 : ticket - upTo;
    const untilStart = Math.max(0, drop.startsAt.getTime() - now) / 1000;
    const result: QueueStatus = {
      dropId: drop.id,
      ticket,
      admittedUpTo: upTo,
      position,
      etaSeconds: Math.ceil(untilStart + position / drop.admitPerSecond),
      admitted,
    };
    if (admitted) {
      const exp = now + PASS_TTL_MS;
      result.pass = this.signer.sign({ d: drop.id, u: userId, t: ticket, exp });
      result.passExpiresAt = new Date(exp).toISOString();
      this.metrics.dropQueue.inc({ result: 'admitted' });
    } else {
      this.metrics.dropQueue.inc({ result: 'waiting' });
    }
    return result;
  }

  /** The ticket of a genuine, unexpired pass for this user and drop; null if the pass isn't valid. */
  checkPass(pass: string | undefined, dropId: number, userId: string, now = Date.now()): number | null {
    if (!pass) return null;
    const claims = this.signer.verify(pass, now);
    return claims !== null && claims.d === dropId && claims.u === userId ? claims.t : null;
  }

  /** For the admin's live monitor: tickets handed out and numbers called so far. Null fields if Redis can't say. */
  async lineStats(drop: DropTiming, now = Date.now()): Promise<{ ticketsIssued: number | null; calledUpTo: number | null; shopping: number | null }> {
    const read = await this.redis.tryRun('drop_line_stats', (r) =>
      Promise.all([r.get(seqKey(drop.id)), r.get(calledKey(drop.id)), r.zCount(activeKey(drop.id), now, '+inf')]),
    );
    if (!read) return { ticketsIssued: null, calledUpTo: null, shopping: null };
    const issued = Number(read[0] ?? 0);
    if (drop.maxShoppers !== null) return { ticketsIssued: issued, calledUpTo: Number(read[1] ?? 0), shopping: read[2] };
    return { ticketsIssued: issued, calledUpTo: Math.min(issued, admittedUpTo(drop, now)), shopping: null };
  }

  /** How many tickets have been handed out (for the drop page). Null if Redis can't say. */
  async ticketsIssued(dropId: number): Promise<number | null> {
    const raw = await this.redis.tryRun('drop_tickets_issued', (r) => r.get(seqKey(dropId)));
    return raw === undefined ? null : Number(raw ?? 0);
  }
}

// {drop:N} is a Redis Cluster hash tag: both keys of one drop land on the same shard, so the script can use both.
const seqKey = (dropId: number) => `{drop:${dropId}}:seq`;
const userKey = (dropId: number, userId: string) => `{drop:${dropId}}:user:${userId}`;
const calledKey = (dropId: number) => `{drop:${dropId}}:called`;
const activeKey = (dropId: number) => `{drop:${dropId}}:active`;
const finishedKey = (dropId: number) => `{drop:${dropId}}:finished`;
