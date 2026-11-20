import { ROOT_CONTEXT, SpanKind, context, propagation, trace, type Context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { SamplingDecision } from '@opentelemetry/sdk-trace';
import { currentTraceparent, withTraceparent } from './trace-context.js';
import { RequestOrMessageRootSampler } from './tracing-sampler.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SAMPLED = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const NOT_SAMPLED = `00-${TRACE_ID}-00f067aa0ba902b7-00`;

describe('RequestOrMessageRootSampler (which spans make it into a trace)', () => {
  const sampler = new RequestOrMessageRootSampler(1);
  const withParent = (traceparent: string): Context =>
    new W3CTraceContextPropagator().extract(ROOT_CONTEXT, { traceparent }, { get: (c, k) => c[k], keys: Object.keys });
  const decide = (ctx: Context, kind: SpanKind, s = sampler) => s.shouldSample(ctx, TRACE_ID, 'span', kind).decision;

  it('inside a trace, follows the parent: kept if the parent was kept, dropped if not', () => {
    expect(decide(withParent(SAMPLED), SpanKind.CLIENT)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(withParent(NOT_SAMPLED), SpanKind.SERVER)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('a new trace starts only at an incoming request or message', () => {
    expect(decide(ROOT_CONTEXT, SpanKind.SERVER)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(ROOT_CONTEXT, SpanKind.CONSUMER)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('background work without a parent is dropped (outbox polling, jobs, metric gauges)', () => {
    expect(decide(ROOT_CONTEXT, SpanKind.CLIENT)).toBe(SamplingDecision.NOT_RECORD); // a query from the relay loop
    expect(decide(ROOT_CONTEXT, SpanKind.INTERNAL)).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(ROOT_CONTEXT, SpanKind.PRODUCER)).toBe(SamplingDecision.NOT_RECORD); // an event saved without a trace
  });

  it('the ratio applies to new traces only', () => {
    const none = new RequestOrMessageRootSampler(0);
    expect(decide(ROOT_CONTEXT, SpanKind.SERVER, none)).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(withParent(SAMPLED), SpanKind.CLIENT, none)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});

describe('carrying a trace through the outbox', () => {
  it('without tracing set up: no traceparent, and the function still runs', () => {
    expect(currentTraceparent()).toBeNull();
    expect(withTraceparent(SAMPLED, () => 42)).toBe(42);
  });

  describe('with tracing set up', () => {
    const manager = new AsyncLocalStorageContextManager();
    beforeAll(() => {
      context.setGlobalContextManager(manager.enable());
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    });
    afterAll(() => {
      propagation.disable();
      context.disable();
    });

    it('the relay publishes inside the trace the outbox row saved', async () => {
      const seen = await withTraceparent(SAMPLED, async () => {
        await new Promise((r) => setTimeout(r, 5)); // survives async work, like the confirm wait
        return currentTraceparent();
      });
      expect(seen).toBe(SAMPLED);
      expect(trace.getSpanContext(context.active())).toBeUndefined(); // and nothing leaks outside
    });

    it('a row without a traceparent is published outside any trace', () => {
      expect(withTraceparent(null, () => currentTraceparent())).toBeNull();
    });
  });
});
