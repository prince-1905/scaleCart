import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** The identity service's Prometheus metrics. Names match the shop's where the meaning is the same (dashboards). */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP request duration, labelled by route template (never by raw URL).',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpInFlight = new Gauge({
    name: 'http_server_requests_in_flight',
    help: 'HTTP requests currently being processed by this process.',
    registers: [this.registry],
  });

  /** Argon2id is slow on purpose: this is where login's CPU goes (and why logins got their own service). */
  readonly passwordHashDuration = new Histogram({
    name: 'password_hash_duration_seconds',
    help: 'Time to hash or verify one password with Argon2id, including thread-pool queueing.',
    labelNames: ['op'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly redisErrors = new Counter({
    name: 'redis_errors_total',
    help: 'Redis commands that failed, timed out, or were skipped because Redis was not connected.',
    labelNames: ['op'] as const,
    registers: [this.registry],
  });

  readonly rateLimit = new Counter({
    name: 'rate_limit_total',
    help: 'Requests checked by the token bucket, by policy, result and which bucket decided.',
    labelNames: ['policy', 'result', 'source'] as const,
    registers: [this.registry],
  });

  /** Two-factor login: enabled, disabled, code_ok, backup_code_ok, wrong_code, locked. */
  readonly twoFactor = new Counter({
    name: 'auth_two_factor_total',
    help: 'Two-factor (authenticator app) events by result.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, eventLoopMonitoringPrecision: 10 });
    // Fraction of time the single JS thread was busy since the previous scrape (~1.0 = CPU-saturated).
    let last = performance.eventLoopUtilization();
    new Gauge({
      name: 'nodejs_eventloop_utilization_ratio',
      help: 'Fraction of time the event loop was active since the last scrape (0..1).',
      registers: [this.registry],
      collect() {
        const now = performance.eventLoopUtilization();
        this.set(performance.eventLoopUtilization(now, last).utilization);
        last = now;
      },
    });
  }
}
