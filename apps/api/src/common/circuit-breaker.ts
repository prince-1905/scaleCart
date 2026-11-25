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
  /**
   * +1 every time the breaker opens. A call only counts if the breaker hasn't opened since the call started (E15b):
   * under load, hundreds of calls are in flight when it opens, and each late timeout used to re-open it (2,362
   * "now open" in one run), restart the open period, and free the half-open trial slot.
   */
  private generation = 0;

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
    let trial = false;
    if (this.state === 'half_open') {
      // Only one trial at a time; everyone else is refused until it answers.
      if (this.trialInFlight) throw new CircuitOpenError(0);
      this.trialInFlight = true;
      trial = true;
    }
    const generation = this.generation;
    try {
      const result = await call();
      if (generation === this.generation) {
        this.failures = 0;
        if (this.state !== 'closed') this.set('closed');
      }
      return result;
    } catch (err) {
      // A call that started before the breaker last opened tells us nothing new: not counted.
      if (generation === this.generation) {
        this.failures++;
        if (trial || this.failures >= this.options.failureThreshold) this.open();
      }
      throw err;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }

  private open() {
    this.generation++;
    this.failures = 0;
    this.openedAt = this.now();
    this.set('open');
  }

  private set(state: BreakerState) {
    this.state = state;
    this.onChange(state);
  }
}
