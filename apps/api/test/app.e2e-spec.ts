import type { INestApplication } from '@nestjs/common';
import type { HttpAdapterName } from '../src/config/env.js';
import { http, startApp } from './support.js';

describe.each<HttpAdapterName>(['fastify', 'express'])('api on %s', (adapter) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await startApp(adapter, { LAB_ENDPOINTS: 'true' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live is up', async () => {
    const res = await http(app).get('/health/live').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready pings every module database', async () => {
    const res = await http(app).get('/health/ready').expect(200);
    expect(Object.keys(res.body.info)).toEqual([
      'db_identity',
      'db_catalog',
      'db_inventory',
      'db_cart',
      'db_orders',
    ]);
  });

  it('tags responses with the serving instance', async () => {
    const res = await http(app).get('/lab/ping').expect(200);
    expect(res.headers['x-instance']).toBeTruthy();
  });

  it('records request metrics by route template, not raw URL', async () => {
    await http(app).get('/lab/io?ms=1').expect(200);
    await http(app).get('/lab/cpu?ms=5000').expect(400);

    const res = await http(app).get('/metrics').expect(200);
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
    const app = await startApp('fastify');
    await http(app).get('/lab/ping').expect(404);
    await app.close();
  });
});
