import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory.js';
import { loadEnv, type HttpAdapterName } from '../src/config/env.js';

async function start(adapter: HttpAdapterName, lab: boolean) {
  const env = loadEnv({
    HTTP_ADAPTER: adapter,
    LAB_ENDPOINTS: String(lab),
    HTTP_ACCESS_LOG: 'false',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(env, { logger: false });
  await app.init();
  if (adapter === 'fastify') {
    await app.getHttpAdapter().getInstance().ready();
  }
  return app;
}

describe.each<HttpAdapterName>(['fastify', 'express'])('api on %s', (adapter) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await start(adapter, true);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live is up', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('tags responses with the serving instance', async () => {
    const res = await request(app.getHttpServer()).get('/lab/ping').expect(200);
    expect(res.headers['x-instance']).toBeTruthy();
  });

  it('records request metrics by route template, not raw URL', async () => {
    await request(app.getHttpServer()).get('/lab/io?ms=1').expect(200);
    await request(app.getHttpServer()).get('/lab/cpu?ms=5000').expect(400);

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toMatch(
      /http_server_request_duration_seconds_count\{method="GET",route="\/lab\/io",status_code="200"\} 1/,
    );
    expect(res.text).toMatch(
      /http_server_request_duration_seconds_count\{method="GET",route="\/lab\/cpu",status_code="400"\} 1/,
    );
    expect(res.text).toContain('nodejs_eventloop_utilization_ratio');
    expect(res.text).toContain('nodejs_eventloop_lag_p99_seconds');
    expect(res.text).not.toContain('route="/metrics"');
  });
});

describe('lab endpoints', () => {
  it('are not exposed unless LAB_ENDPOINTS=true', async () => {
    const app = await start('fastify', false);
    await request(app.getHttpServer()).get('/lab/ping').expect(404);
    await app.close();
  });
});
