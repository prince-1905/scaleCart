/**
 * Distributed tracing (Phase 10): OpenTelemetry, exported to Jaeger. Loaded BEFORE the app, so it can patch the
 * libraries the app imports (http, fetch, mysql2, redis, amqplib, pino):
 *
 *   node --import ./dist/tracing.js dist/main.js
 *
 * Does nothing unless TRACING_ENABLED=true, so tests and lab runs without tracing pay nothing.
 * Settings (standard OpenTelemetry variables where they exist):
 *   OTEL_SERVICE_NAME              shop-api / shop-worker / payments (the name shown in Jaeger)
 *   OTEL_EXPORTER_OTLP_ENDPOINT    http://jaeger:4318
 *   TRACING_SAMPLE_RATIO           share of NEW traces to keep, 0..1 (default 1). Requests that come with a sampling
 *                                  decision (from Kong, or inside an event) follow that decision.
 */
import { register } from 'node:module';

if (process.env.TRACING_ENABLED === 'true') {
  // ESM apps: lets OpenTelemetry patch modules loaded with `import` (CommonJS ones are patched through require).
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
  const { RequestOrMessageRootSampler } = await import('./common/tracing-sampler.js');

  const quiet = new Set(['/metrics', '/health/live', '/health/ready']);
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    sampler: new RequestOrMessageRootSampler(Number(process.env.TRACING_SAMPLE_RATIO ?? 1)),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Very chatty and not useful here: every file read, DNS lookup and socket.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Prometheus scrapes and health checks every few seconds: no traces for them.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => quiet.has((req.url ?? '').split('?')[0]),
        },
      }),
    ],
  });
  sdk.start();

  // Send what's still buffered when the process stops (spans are exported in batches every few seconds).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void sdk.shutdown().catch(() => undefined));
  }
}
