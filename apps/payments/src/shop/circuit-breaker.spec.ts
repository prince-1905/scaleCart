import { CircuitBreaker, CircuitOpenError, type BreakerState } from './circuit-breaker.js';

const fail = () => Promise.reject(new Error('shop down'));
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
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow('shop down');
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
    await expect(breaker.run(fail)).rejects.toThrow('shop down'); // the trial failed
    expect(breaker.current).toBe('open');
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError); // open again, for another 10 s

    advance(10_000);
    expect(await breaker.run(ok)).toBe('ok');
    expect(breaker.current).toBe('closed');
    expect(states).toEqual(['open', 'half_open', 'open', 'half_open', 'closed']);
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
