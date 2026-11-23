import { lookup as dnsLookup, type LookupOptions } from 'node:dns';

type Callback = (...args: unknown[]) => void;
export type LookupFn = (hostname: string, options: LookupOptions, callback: Callback) => void;

/**
 * A DNS lookup for an HTTP agent: concurrent lookups of the same name share ONE real lookup, and the answer is kept
 * briefly (a failure too).
 *
 * Why (E15): Node resolves names on its small thread pool (4 threads), the same pool every new MySQL connection needs.
 * With OpenSearch's container stopped, Docker's DNS takes ~4 s to say "no such host". 200 searches in the first second
 * meant ~200 lookups, each holding a thread for 4 s: the cart's new MySQL connections queued behind them and failed
 * with "connect ETIMEDOUT", although MySQL itself was idle. Shared, one dead name costs one thread.
 *
 * Like asking the front desk once for a room number and passing it around, instead of 200 guests queueing to ask.
 */
export function sharedLookup(
  options: { okMs?: number; failMs?: number; lookup?: LookupFn; now?: () => number } = {},
): LookupFn {
  const okMs = options.okMs ?? 5_000; // short: a recreated container gets a new IP (Kong kept old IPs for minutes)
  const failMs = options.failMs ?? 2_000;
  const lookup = options.lookup ?? (dnsLookup as unknown as LookupFn);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { args: unknown[]; until: number }>();
  const waiting = new Map<string, Callback[]>();

  return (hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'function') {
      callback = lookupOptions as Callback;
      lookupOptions = {};
    }
    // net.connect asks with { all: true } when it tries several addresses: those answers have another shape.
    const key = `${hostname}|${lookupOptions.family ?? 0}|${lookupOptions.all ? 'all' : 'one'}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) {
      process.nextTick(() => callback(...hit.args));
      return;
    }
    const queue = waiting.get(key);
    if (queue) {
      queue.push(callback);
      return;
    }
    waiting.set(key, [callback]);
    lookup(hostname, lookupOptions, (...args: unknown[]) => {
      cache.set(key, { args, until: now() + (args[0] ? failMs : okMs) });
      const callbacks = waiting.get(key) ?? [];
      waiting.delete(key);
      for (const cb of callbacks) cb(...args);
    });
  };
}
