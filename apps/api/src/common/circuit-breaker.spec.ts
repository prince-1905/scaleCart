import { CircuitBreaker, CircuitOpenError, type BreakerState } from './circuit-breaker.js';

const fail = () => Promise.reject(new Error('service down'));
const ok = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  function setup() {
    let now = 0;
    const states: BreakerState[] = [];
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 10_000 }, (s) => states.push(s), () => now);
    return { breaker, states, advance: (ms: number) => (now += ms) };
  }

  it('opens after 3 failures in a row, then refuses at once without calling', async () => {
    const { breaker, states } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow('service down');
    expect(breaker.current).toBe('open');

    let called = false;
    await expect(
      breaker.run(() => {
        called = true;
        return ok();
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
    expect(states).toEqual(['open']);
  });

  it('a success resets the count: failures must be consecutive', async () => {
    const { breaker } = setup();
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    await breaker.run(ok);
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    expect(breaker.current).toBe('closed');
  });

  it('after the open period: one trial call; success closes, failure opens again', async () => {
    const { breaker, states, advance } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow();
    advance(10_000);
    await expect(breaker.run(fail)).rejects.toThrow('service down'); // the trial failed
    expect(breaker.current).toBe('open');
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError); // open again, for another 10 s

    advance(10_000);
    expect(await breaker.run(ok)).toBe('ok');
    expect(breaker.current).toBe('closed');
    expect(states).toEqual(['open', 'half_open', 'open', 'half_open', 'closed']);
  });

  it('calls already in flight when it opens do not re-open it or restart the open period (E15b)', async () => {
    const { breaker, states, advance } = setup();
    // 10 slow calls in flight, then they all time out at once.
    const rejects: (() => void)[] = [];
    const inFlight = Array.from({ length: 10 }, () =>
      breaker.run(() => new Promise<string>((_, reject) => rejects.push(() => reject(new Error('timeout'))))),
    );
    advance(1_000);
    for (const r of rejects) r();
    await Promise.allSettled(inFlight);
    expect(states).toEqual(['open']); // opened once, not 8 more times

    advance(10_000); // 10 s after the FIRST failure, not after the last
    expect(await breaker.run(ok)).toBe('ok');
    expect(breaker.current).toBe('closed');
  });

  it('only the trial decides half-open: an old call finishing late neither closes it nor frees the trial slot', async () => {
    const { breaker, states, advance } = setup();
    let releaseOld!: () => void;
    const old = breaker.run(() => new Promise<string>((r) => (releaseOld = () => r('late ok'))));
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow();
    advance(10_000);
    let releaseTrial!: () => void;
    const trial = breaker.run(() => new Promise<string>((r) => (releaseTrial = () => r('ok'))));
    releaseOld();
    expect(await old).toBe('late ok');
    expect(breaker.current).toBe('half_open'); // the old success did not close it
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError); // the trial slot is still taken
    releaseTrial();
    expect(await trial).toBe('ok');
    expect(states).toEqual(['open', 'half_open', 'closed']);
  });

  it('half-open lets only ONE trial through at a time', async () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow();
    advance(10_000);
    let release!: () => void;
    const trial = breaker.run(() => new Promise<string>((r) => (release = () => r('ok'))));
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    expect(await trial).toBe('ok');
  });
});
