import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

const CGROUP_CPU_STAT = '/sys/fs/cgroup/cpu.stat';

/** Reads cgroup v2 CPU stats (Linux containers only); null elsewhere. */
function readCgroupCpuStat(): Record<string, number> | null {
  try {
    const text = readFileSync(CGROUP_CPU_STAT, 'utf8');
    return Object.fromEntries(
      text
        .trim()
        .split('\n')
        .map((line) => line.split(' '))
        .map(([key, value]) => [key, Number(value)]),
    );
  } catch {
    return null;
  }
}

/**
 * Owns the Prometheus registry for this process.
 *
 * A per-instance registry (instead of prom-client's global one) keeps tests
 * isolated and makes it impossible to register the same metric twice.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** RED metrics: Rate, Errors and Duration all come from this one histogram. */
  readonly httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP request duration, labelled by route template (never by raw URL).',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [
      0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ],
    registers: [this.registry],
  });

  /** Requests currently being processed. Little's law: inFlight = RPS x latency. */
  readonly httpInFlight = new Gauge({
    name: 'http_server_requests_in_flight',
    help: 'HTTP requests currently being processed by this process.',
    registers: [this.registry],
  });

  constructor() {
    // CPU, memory, heap, GC pauses and event-loop delay (p50/p90/p99, via perf_hooks).
    collectDefaultMetrics({
      register: this.registry,
      eventLoopMonitoringPrecision: 10,
    });

    // Event-loop utilization: the fraction of time the single JS thread was busy
    // since the previous scrape. ~1.0 means this process is CPU-saturated even
    // if the container still has spare cores.
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

    // CPU throttling: time the kernel paused this container because it used up its
    // CPU quota (the Docker/Kubernetes CPU *limit*). Throttling shows up as latency
    // spikes, not as "slower CPU", which is why it deserves its own metric.
    if (readCgroupCpuStat()) {
      new Counter({
        name: 'container_cpu_throttled_seconds_total',
        help: 'Total time this container was throttled by its CPU limit (cgroup cpu.stat).',
        registers: [this.registry],
        collect() {
          const stat = readCgroupCpuStat();
          if (!stat) return;
          this.reset();
          this.inc((stat.throttled_usec ?? 0) / 1e6);
        },
      });
      new Counter({
        name: 'container_cpu_throttled_periods_total',
        help: 'Number of scheduler periods in which this container was throttled.',
        registers: [this.registry],
        collect() {
          const stat = readCgroupCpuStat();
          if (!stat) return;
          this.reset();
          this.inc(stat.nr_throttled ?? 0);
        },
      });
    }
  }
}
