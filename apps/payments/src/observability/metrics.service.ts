import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** This service's Prometheus metrics. Names match the shop's where the meaning is the same, so dashboards carry over. */
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

  /** Payment results by outcome (paid, duplicate, refund, failed…) and where they came from (webhook, browser, reconcile). */
  readonly payments = new Counter({
    name: 'payments_total',
    help: 'Payments reported by the provider, by outcome and source.',
    labelNames: ['outcome', 'source'] as const,
    registers: [this.registry],
  });

  readonly paymentWebhooks = new Counter({
    name: 'payment_webhooks_total',
    help: 'Provider webhooks by event type and result.',
    labelNames: ['event', 'result'] as const,
    registers: [this.registry],
  });

  readonly paymentJobs = new Counter({
    name: 'payment_jobs_total',
    help: 'Work done by the payment jobs.',
    labelNames: ['job'] as const,
    registers: [this.registry],
  });

  /** Calls to the shop's internal API: ok, error (after the retry), timeout, open (refused by the circuit breaker). */
  readonly shopCalls = new Counter({
    name: 'shop_calls_total',
    help: 'Calls from the payments service to the shop, by operation and result.',
    labelNames: ['op', 'result'] as const,
    registers: [this.registry],
  });

  readonly shopCallDuration = new Histogram({
    name: 'shop_call_duration_seconds',
    help: 'Duration of calls to the shop (each try).',
    labelNames: ['op'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  /** 0 = closed (calls go through), 1 = open (calls refused at once), 0.5 = half-open (one trial call). */
  readonly shopBreaker = new Gauge({
    name: 'shop_circuit_breaker_state',
    help: 'Circuit breaker for calls to the shop: 0 closed, 0.5 half-open, 1 open.',
    registers: [this.registry],
  });

  /** Events this service published (payment.captured…) and events it consumed (order.payment_result). */
  readonly events = new Counter({
    name: 'payment_events_total',
    help: 'Events published and consumed by the payments service.',
    labelNames: ['direction', 'type', 'result'] as const,
    registers: [this.registry],
  });

  readonly rabbitConnected = new Gauge({
    name: 'rabbitmq_connected',
    help: '1 when this process is connected to RabbitMQ.',
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events published to RabbitMQ.',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, eventLoopMonitoringPrecision: 10 });
  }
}
