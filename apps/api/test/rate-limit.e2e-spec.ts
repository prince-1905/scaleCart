import type { INestApplication } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { RedisService } from '../src/cache/redis.service.js';
import type { HttpAdapterName } from '../src/config/env.js';
import { http, metric, registerUser, startApp } from './support.js';

/** Small buckets so the tests can empty them quickly; auth is roomy unless a test is about auth. */
const LIMITS = {
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_DEFAULT: '5:0.01',
  RATE_LIMIT_AUTH: '1000:100',
  RATE_LIMIT_CHECKOUT: '2:0.01',
};

const LIMITED = /rate_limit_total\{policy="default",result="limited",source="redis"\} (\d+)/;

/** All requests here come from 127.0.0.1, so each test starts with no buckets in Redis. */
async function clearBuckets(app: INestApplication) {
  await app.get(RedisService).tryRun('test_clear', async (r) => {
    const keys = await r.keys('ratelimit:*');
    if (keys.length) await r.del(keys);
  });
}

describe.each<HttpAdapterName>(['fastify', 'express'])('rate limit on %s', (adapter) => {
  const apps: INestApplication[] = [];
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    const app = await startApp(adapter, { ...LIMITS, ...overrides });
    apps.push(app);
    await clearBuckets(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  it('a full bucket allows a burst of 5, then answers 429 with Retry-After', async () => {
    const app = await start();
    const before = await metric(app, LIMITED);
    for (let i = 0; i < 5; i++) await http(app).get('/products').expect(200);

    const refused = await http(app).get('/products').expect(429);
    expect(refused.body).toMatchObject({ error: 'rate_limited', statusCode: 429 });
    // 0.01 tokens/s: the next one is ~100 s away.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(99);
    expect(refused.body.retryAfterSeconds).toBe(Number(refused.headers['retry-after']));
    expect(await metric(app, LIMITED)).toBe(before + 1);
  });

  it('tokens come back with time, at the refill rate', async () => {
    // One token every 500 ms: slow enough that a busy machine (a request taking a few hundred ms) can't refill a
    // token between two requests that expect 429. With 200 ms per token this flaked once in a full run (2026-11-17).
    const app = await start({ RATE_LIMIT_DEFAULT: '2:2' });
    await http(app).get('/products').expect(200);
    await http(app).get('/products').expect(200);
    await http(app).get('/products').expect(429);

    await sleep(600);
    await http(app).get('/products').expect(200);
    await http(app).get('/products').expect(429);

    // Quiet for 1.5 s would "earn" 3 tokens, but the bucket holds at most 2.
    await sleep(1500);
    await http(app).get('/products').expect(200);
    await http(app).get('/products').expect(200);
    await http(app).get('/products').expect(429);
  });

  it('50 requests at once against 10 tokens: exactly 10 get through (one atomic step in Redis)', async () => {
    const app = await start({ RATE_LIMIT_DEFAULT: '10:0.01' });
    const statuses = await Promise.all(
      Array.from({ length: 50 }, () => http(app).get('/products').then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(40);
  });

  it('two API replicas share one bucket: switching pods gives no extra tokens', async () => {
    const a = await start();
    const b = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await http(i % 2 ? b : a).get('/products')).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
  });

  it('logged-in shoppers each get their own bucket, even from the same IP', async () => {
    const app = await start();
    const [ana, ben] = [await registerUser(app), await registerUser(app)];
    const cart = (token: string) => http(app).get('/cart').set('Authorization', `Bearer ${token}`);

    for (let i = 0; i < 5; i++) await cart(ana.accessToken).expect(200);
    await cart(ana.accessToken).expect(429);
    // Ben shares Ana's IP but not her bucket; logged-out browsing (the IP's bucket) is untouched too.
    await cart(ben.accessToken).expect(200);
    await http(app).get('/products').expect(200);
  });

  it('public pages count a logged-in shopper by user too, not by the shared IP (E9 bug)', async () => {
    const app = await start();
    const [ana, ben] = [await registerUser(app), await registerUser(app)];
    const browse = (token: string) => http(app).get('/products').set('Authorization', `Bearer ${token}`);
    for (let i = 0; i < 5; i++) await browse(ana.accessToken).expect(200);
    await browse(ana.accessToken).expect(429);
    await browse(ben.accessToken).expect(200);
    // A bad token on a public route is no error, and counts by IP.
    await http(app).get('/products').set('Authorization', 'Bearer not-a-token').expect(200);
  });

  it('checkout has its own, smaller bucket', async () => {
    const app = await start();
    const user = await registerUser(app);
    const checkout = () =>
      http(app).post('/checkout').set('Authorization', `Bearer ${user.accessToken}`).send({});

    // Empty cart → 4xx from checkout itself, but each attempt still takes a token.
    for (let i = 0; i < 2; i++) expect((await checkout()).status).not.toBe(429);
    expect((await checkout()).status).toBe(429);
    // The default bucket is separate: the same user can still browse.
    await http(app).get('/cart').set('Authorization', `Bearer ${user.accessToken}`).expect(200);
  });

  // Login's per-IP limit moved to the identity service (Phase 11): apps/identity/test.

  it('never limits health checks or metrics', async () => {
    const app = await start({ RATE_LIMIT_DEFAULT: '1:0.01' });
    for (let i = 0; i < 5; i++) {
      await http(app).get('/health/live').expect(200);
      await http(app).get('/metrics').expect(200);
    }
  });

  it('X-Real-IP is trusted only with TRUST_PROXY=true', async () => {
    const direct = await start();
    // Without a proxy, a made-up header must not buy a fresh bucket.
    for (let i = 0; i < 5; i++) await http(direct).get('/products').set('X-Real-IP', `10.0.0.${i}`).expect(200);
    await http(direct).get('/products').set('X-Real-IP', '10.0.0.99').expect(429);
    await direct.close();
    apps.splice(0);

    const behindNginx = await start({ TRUST_PROXY: 'true' });
    for (let i = 0; i < 5; i++) await http(behindNginx).get('/products').set('X-Real-IP', '10.0.0.1').expect(200);
    await http(behindNginx).get('/products').set('X-Real-IP', '10.0.0.1').expect(429);
    await http(behindNginx).get('/products').set('X-Real-IP', '10.0.0.2').expect(200);
  });
});
