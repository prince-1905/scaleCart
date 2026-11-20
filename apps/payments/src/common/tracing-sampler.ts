import { SpanKind, isSpanContextValid, trace, type Context } from '@opentelemetry/api';
import {
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
} from '@opentelemetry/sdk-trace';

/**
 * Which spans become part of a trace.
 *
 * - A span with a parent (inside a request, or continuing a trace that came with a request or an event) follows the
 *   parent's decision, so a trace is either complete or absent.
 * - A NEW trace may only start where work starts: an incoming request (SERVER) or an incoming message (CONSUMER),
 *   kept with probability `ratio`.
 * - Everything else without a parent is dropped: the outbox relay polling every 200 ms, cleanup jobs, metric gauges.
 *   Otherwise Jaeger fills up with thousands of one-query "traces" nobody wants.
 */
export class RequestOrMessageRootSampler implements Sampler {
  private readonly ratio: TraceIdRatioBasedSampler;

  constructor(ratio: number) {
    this.ratio = new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1);
  }

  shouldSample(context: Context, traceId: string, _spanName: string, spanKind: SpanKind): SamplingResult {
    const parent = trace.getSpanContext(context);
    if (parent && isSpanContextValid(parent)) {
      const sampled = (parent.traceFlags & 1) === 1;
      return { decision: sampled ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
    }
    if (spanKind !== SpanKind.SERVER && spanKind !== SpanKind.CONSUMER) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.ratio.shouldSample(context, traceId);
  }

  toString() {
    return `RequestOrMessageRootSampler{${this.ratio.toString()}}`;
  }
}
