import { ROOT_CONTEXT, context, propagation } from '@opentelemetry/api';

/**
 * Carrying a trace through the outbox (Phase 10).
 *
 * An event is saved in the request's transaction but published LATER by the relay, outside that request. To keep
 * "request → event → consumer" in one trace, the outbox row stores the request's W3C `traceparent`
 * ("00-<trace id>-<span id>-01"), and the relay publishes the row inside that context: the RabbitMQ instrumentation
 * then puts it into the message headers, and the consumer continues the same trace.
 *
 * Without tracing (tests, TRACING_ENABLED=false) both functions are no-ops: no traceparent, plain call.
 */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** Runs `fn` as part of the trace that `traceparent` points to (or of no trace). */
export function withTraceparent<T>(traceparent: string | null | undefined, fn: () => T): T {
  const ctx = traceparent ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;
  return context.with(ctx, fn);
}
