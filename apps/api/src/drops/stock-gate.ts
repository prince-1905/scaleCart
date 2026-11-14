import { Injectable } from '@nestjs/common';
import { RedisService } from '../cache/redis.service.js';
import { MetricsService } from '../observability/metrics.service.js';

/**
 * Takes `qty` only if at least `qty` is left, in one atomic step.
 * KEYS: the drop's counter · ARGV: qty
 * Returns 1 = taken, 0 = not enough left, -1 = no counter yet (load it from MySQL first)
 */
const TAKE_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then return -1 end
if tonumber(v) < tonumber(ARGV[1]) then return 0 end
redis.call('DECRBY', KEYS[1], ARGV[1])
return 1`;

/** Counters are forgotten a day after they were last set. */
const COUNTER_TTL_SECONDS = 24 * 3600;

export type GateAnswer = 'taken' | 'sold_out' | 'unavailable';

/**
 * A fast "door counter" for a drop's stock in Redis, in front of the MySQL stock row.
 *
 * It only decides who may *try* MySQL: when it reaches 0, everyone after gets "sold out" in
 * about a millisecond instead of queueing for the product's row lock (the hot row, E5).
 * MySQL's conditional UPDATE still decides who actually gets a unit, so a wrong counter can
 * make us sell fewer for a moment (until the next reset), never more.
 *
 * Fails open: if Redis can't answer, checkout goes straight to MySQL, as before the gate.
 */
@Injectable()
export class StockGate {
  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /** `loadAvailable` reads MySQL's real number; called only when the counter doesn't exist yet. */
  async take(dropId: number, qty: number, loadAvailable: () => Promise<number>): Promise<GateAnswer> {
    let reply = await this.run(dropId, qty);
    if (reply === -1) {
      const available = await loadAvailable();
      // NX: if another request created it in the meantime, keep theirs.
      await this.redis.tryRun('stock_gate_init', (r) =>
        r.set(counterKey(dropId), String(available), { NX: true, EX: COUNTER_TTL_SECONDS }),
      );
      reply = await this.run(dropId, qty);
    }
    const answer: GateAnswer = reply === 1 ? 'taken' : reply === 0 ? 'sold_out' : 'unavailable';
    this.metrics.dropStockGate.inc({ result: answer });
    return answer;
  }

  /** Undo a take(): the checkout failed after the gate, so the unit is back on the shelf. */
  async giveBack(dropId: number, qty: number): Promise<void> {
    // XX: only if the counter still exists; a missing one is reloaded from MySQL anyway.
    await this.redis.tryRun('stock_gate_return', async (r) => {
      if (await r.exists(counterKey(dropId))) await r.incrBy(counterKey(dropId), qty);
    });
  }

  /**
   * Resets the counter to MySQL's real number (only if it exists). Safe even while buyers are
   * checking out: a few in-flight takes may make the counter a little too high for a moment,
   * which lets a few extra buyers try MySQL, and MySQL refuses them. Never oversells.
   */
  async reset(dropId: number, available: number): Promise<void> {
    await this.redis.tryRun('stock_gate_reset', (r) =>
      r.set(counterKey(dropId), String(available), { XX: true, EX: COUNTER_TTL_SECONDS }),
    );
  }

  /** Units the counter still allows; undefined if there's no counter yet or Redis can't answer. */
  async peek(dropId: number): Promise<number | undefined> {
    const raw = await this.redis.tryRun('stock_gate_peek', (r) => r.get(counterKey(dropId)));
    return raw === undefined || raw === null ? undefined : Number(raw);
  }

  private async run(dropId: number, qty: number): Promise<number | undefined> {
    const reply = await this.redis.tryRun('stock_gate_take', (r) =>
      r.eval(TAKE_SCRIPT, { keys: [counterKey(dropId)], arguments: [String(qty)] }),
    );
    return typeof reply === 'number' ? reply : undefined;
  }
}

const counterKey = (dropId: number) => `{drop:${dropId}}:stock`;
