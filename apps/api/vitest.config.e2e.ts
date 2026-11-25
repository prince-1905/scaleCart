import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Needs MySQL: `docker compose up -d mysql` first.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Every file starts its own API (and often a worker) against the same MySQL, Redis, RabbitMQ and OpenSearch. All
    // 11 at once next to the running stack overloaded the laptop (Phase 13: health checks 503, RabbitMQ connects and
    // timing tests failing; 3–5 failing files per run). 4 at a time: all pass, ~100 s.
    maxWorkers: 4,
  },
});
