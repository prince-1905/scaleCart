import { sharedLookup, type LookupFn } from './shared-lookup.js';

function fakeDns() {
  const calls: string[] = [];
  const pending: ((...args: unknown[]) => void)[] = [];
  const lookup: LookupFn = (hostname, _options, callback) => {
    calls.push(hostname);
    pending.push(callback);
  };
  return { lookup, calls, answer: (...args: unknown[]) => pending.shift()!(...args) };
}

const ask = (lookup: LookupFn, host: string, options = {}) =>
  new Promise<unknown[]>((resolve) => lookup(host, options, (...args) => resolve(args)));

describe('sharedLookup', () => {
  it('100 concurrent lookups of a dead name cost ONE real lookup, and the failure is reused for a while', async () => {
    const dns = fakeDns();
    let now = 0;
    const lookup = sharedLookup({ lookup: dns.lookup, failMs: 2_000, now: () => now });
    const answers = Array.from({ length: 100 }, () => ask(lookup, 'opensearch'));
    expect(dns.calls).toEqual(['opensearch']);
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND opensearch'), { code: 'ENOTFOUND' });
    dns.answer(notFound);
    for (const a of await Promise.all(answers)) expect(a[0]).toBe(notFound);

    now = 1_999;
    expect((await ask(lookup, 'opensearch'))[0]).toBe(notFound); // still cached: fails at once
    expect(dns.calls).toHaveLength(1);
    now = 2_000;
    const again = ask(lookup, 'opensearch');
    expect(dns.calls).toHaveLength(2); // expired: asks DNS again
    dns.answer(null, '172.27.0.9', 4);
    expect(await again).toEqual([null, '172.27.0.9', 4]);
  });

  it('keeps a good answer only briefly, and keeps "all addresses" answers apart from single ones', async () => {
    const dns = fakeDns();
    let now = 0;
    const lookup = sharedLookup({ lookup: dns.lookup, okMs: 5_000, now: () => now });
    const one = ask(lookup, 'mysql');
    const all = ask(lookup, 'mysql', { all: true });
    expect(dns.calls).toEqual(['mysql', 'mysql']);
    dns.answer(null, '172.27.0.2', 4);
    dns.answer(null, [{ address: '172.27.0.2', family: 4 }]);
    expect(await one).toEqual([null, '172.27.0.2', 4]);
    expect(await all).toEqual([null, [{ address: '172.27.0.2', family: 4 }]]);

    now = 4_999;
    await ask(lookup, 'mysql');
    expect(dns.calls).toHaveLength(2);
    now = 5_000;
    void ask(lookup, 'mysql');
    expect(dns.calls).toHaveLength(3); // a recreated container may have a new IP: ask again
  });
});
