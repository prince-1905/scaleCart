/**
 * A circuit breaker: stop calling a service that keeps failing, so callers fail in microseconds instead of each
 * waiting for a timeout, and the struggling service gets a break.
 *
 *   closed     calls go through; count consecutive failures
 *   open       after `failureThreshold` failures in a row: refuse every call for `openMs`
 *   half-open  then let ONE trial call through: success → closed, failure → open again
 *
 * Like a fuse box: when a circuit keeps tripping, cut it off, and try it again after a while.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(readonly retryInMs: number) {
    super(`circuit open: not calling for another ${retryInMs} ms`);
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';
  private trialInFlight = false;

  constructor(
    private readonly options: { failureThreshold: number; openMs: number },
    private readonly onChange: (state: BreakerState) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  get current(): BreakerState {
    return this.state;
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const waited = this.now() - this.openedAt;
      if (waited < this.options.openMs) throw new CircuitOpenError(this.options.openMs - waited);
      this.set('half_open');
    }
    if (this.state === 'half_open') {
      // Only one trial at a time; everyone else is refused until it answers.
      if (this.trialInFlight) throw new CircuitOpenError(0);
      this.trialInFlight = true;
    }
    try {
      const result = await call();
      this.failures = 0;
      if (this.state !== 'closed') this.set('closed');
      return result;
    } catch (err) {
      this.failures++;
      if (this.state === 'half_open' || this.failures >= this.options.failureThreshold) {
        this.openedAt = this.now();
        this.set('open');
      }
      throw err;
    } finally {
      this.trialInFlight = false;
    }
  }

  private set(state: BreakerState) {
    this.state = state;
    this.onChange(state);
  }
}
