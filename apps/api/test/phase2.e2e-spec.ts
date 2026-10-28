import type { INestApplication } from '@nestjs/common';
import type { HttpAdapterName } from '../src/config/env.js';
import {
  createProduct,
  http,
  metric,
  registerAdmin,
  registerUser,
  startApp,
  type TestUser,
} from './support.js';

const HITS = /cache_requests_total\{cache="product",result="hit"\} (\d+)/;
const MISSES = /cache_requests_total\{cache="product",result="miss"\} (\d+)/;

describe.each<HttpAdapterName>(['fastify', 'express'])('phase 2 on %s', (adapter) => {
  let app: INestApplication;
  let admin: TestUser;

  beforeAll(async () => {
    app = await startApp(adapter);
    admin = await registerAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('product cache', () => {
    it('serves the second read from Redis', async () => {
      const id = await createProduct(app, admin);
      const [hits, misses] = [await metric(app, HITS), await metric(app, MISSES)];

      const first = await http(app).get(`/products/${id}`).expect(200);
      const second = await http(app).get(`/products/${id}`).expect(200);

      expect(second.body).toEqual(first.body);
      expect(await metric(app, MISSES)).toBe(misses + 1);
      expect(await metric(app, HITS)).toBe(hits + 1);
    });

    it('shows a price change immediately (the write deletes the cached copy)', async () => {
      const id = await createProduct(app, admin, { priceCents: 1000 });
      await http(app).get(`/products/${id}`).expect(200); // now cached at 1000

      await http(app)
        .patch(`/products/${id}`)
        .auth(admin.accessToken, { type: 'bearer' })
        .send({ priceCents: 1500 })
        .expect(200);

      const res = await http(app).get(`/products/${id}`).expect(200);
      expect(res.body.priceCents).toBe(1500);
    });

    it('caches "not found" too, so bots asking for missing ids don’t all reach MySQL', async () => {
      const missing = 3_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      const misses = await metric(app, MISSES);
      await http(app).get(`/products/${missing}`).expect(404);
      await http(app).get(`/products/${missing}`).expect(404);
      expect(await metric(app, MISSES)).toBe(misses + 1);
    });

    it('lets only admins change products', async () => {
      const id = await createProduct(app, admin);
      const customer = await registerUser(app);
      await http(app)
        .patch(`/products/${id}`)
        .auth(customer.accessToken, { type: 'bearer' })
        .send({ priceCents: 1 })
        .expect(403);
    });
  });

  describe('login throttling', () => {
    const fail = (u: TestUser) =>
      http(app).post('/auth/login').send({ email: u.email, password: 'wrong-password' });

    it('refuses logins for an account after 5 failures, even with the right password', async () => {
      const user = await registerUser(app);
      for (let i = 0; i < 5; i++) await fail(user).expect(401);

      const blocked = await http(app)
        .post('/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(429);
      expect(blocked.body).toMatchObject({ error: 'too_many_failed_logins' });
      expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('resets the count after a successful login', async () => {
      const user = await registerUser(app);
      for (let i = 0; i < 4; i++) await fail(user).expect(401);
      await http(app).post('/auth/login').send({ email: user.email, password: user.password }).expect(200);
      for (let i = 0; i < 4; i++) await fail(user).expect(401);
    });
  });

  it('serves the OpenAPI document and Swagger UI', async () => {
    const doc = await http(app).get('/docs-json').expect(200);
    expect(Object.keys(doc.body.paths)).toEqual(
      expect.arrayContaining(['/auth/login', '/products/{id}', '/checkout']),
    );
    await http(app).get('/docs').expect(200);
  });
});

describe('without Redis (fail open)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Nothing listens on this port: the app must still start and serve everything from MySQL.
    app = await startApp('fastify', { REDIS_URL: 'redis://127.0.0.1:6390' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('still serves products, logins and checkout', async () => {
    const admin = await registerAdmin(app);
    const id = await createProduct(app, admin, { stock: 1 });
    await http(app).get(`/products/${id}`).expect(200);

    const user = await registerUser(app);
    await http(app).post('/auth/login').send({ email: user.email, password: 'wrong-password' }).expect(401);
    await http(app)
      .put(`/cart/items/${id}`)
      .auth(user.accessToken, { type: 'bearer' })
      .send({ quantity: 1 })
      .expect(200);
    await http(app)
      .post('/checkout')
      .auth(user.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', `no-redis-${id}`)
      .send({})
      .expect(201);

    expect(await metric(app, /redis_errors_total\{op="get"\} (\d+)/)).toBeGreaterThan(0);
  });
});
