import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { HttpAdapterName, StockReservationStrategy } from '../src/config/env.js';
import {
  createProduct,
  http,
  registerAdmin,
  registerUser,
  startApp,
  unique,
  type TestUser,
} from './support.js';

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

async function addToCart(app: INestApplication, user: TestUser, productId: number, quantity: number) {
  await http(app)
    .put(`/cart/items/${productId}`)
    .set(bearer(user))
    .send({ quantity })
    .expect(200);
}

function checkout(app: INestApplication, user: TestUser, key = randomUUID(), body: object = {}) {
  return http(app).post('/checkout').set(bearer(user)).set('Idempotency-Key', key).send(body);
}

async function stockOf(app: INestApplication, productId: number): Promise<number> {
  const res = await http(app).get(`/inventory/${productId}`).expect(200);
  return res.body.available;
}

describe.each<HttpAdapterName>(['fastify', 'express'])('shop on %s', (adapter) => {
  let app: INestApplication;
  let admin: TestUser;

  beforeAll(async () => {
    app = await startApp(adapter);
    admin = await registerAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('catalog', () => {
    it('only admins can create products', async () => {
      const customer = await registerUser(app);
      await http(app)
        .post('/products')
        .set(bearer(customer))
        .send({ sku: unique('SKU'), name: 'x', priceCents: 100 })
        .expect(403);
    });

    it('finds products by word prefix with FULLTEXT search', async () => {
      const word = `zq${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const id = await createProduct(app, admin, { name: `${word} sneaker` });

      const res = await http(app).get('/products').query({ q: word.slice(0, 8) }).expect(200);
      expect(res.body.items.map((p: { id: number }) => p.id)).toEqual([id]);
    });

    it('pages through products with a keyset cursor', async () => {
      const ids = [
        await createProduct(app, admin),
        await createProduct(app, admin),
        await createProduct(app, admin),
      ];
      const page1 = await http(app)
        .get('/products')
        .query({ after: ids[0] - 1, limit: 2 })
        .expect(200);
      expect(page1.body.items.map((p: { id: number }) => p.id)).toEqual(ids.slice(0, 2));
      expect(page1.body.nextAfter).toBe(ids[1]);

      const page2 = await http(app)
        .get('/products')
        .query({ after: page1.body.nextAfter, limit: 2 })
        .expect(200);
      expect(page2.body.items[0].id).toBe(ids[2]);
    });

    it('validates query parameters', async () => {
      await http(app).get('/products').query({ limit: 1000 }).expect(400);
      await http(app).get('/products/abc').expect(400);
      await http(app).get('/products/999999999').expect(404);
    });
  });

  describe('checkout', () => {
    it('turns the cart into an order, takes stock and empties the cart', async () => {
      const user = await registerUser(app);
      const productId = await createProduct(app, admin, { priceCents: 1250, stock: 5 });
      await addToCart(app, user, productId, 2);

      const res = await checkout(app, user).expect(201);
      expect(res.body).toMatchObject({
        status: 'pending_payment',
        totalCents: 2500,
        items: [{ productId, quantity: 2, unitPriceCents: 1250 }],
      });
      expect(await stockOf(app, productId)).toBe(3);

      const cart = await http(app).get('/cart').set(bearer(user)).expect(200);
      expect(cart.body.items).toEqual([]);

      const order = await http(app).get(`/orders/${res.body.id}`).set(bearer(user)).expect(200);
      expect(order.body.totalCents).toBe(2500);
      const list = await http(app).get('/orders').set(bearer(user)).expect(200);
      expect(list.body.items[0].id).toBe(res.body.id);
    });

    it('hides other customers’ orders', async () => {
      const [alice, bob] = [await registerUser(app), await registerUser(app)];
      const productId = await createProduct(app, admin);
      await addToCart(app, alice, productId, 1);
      const order = await checkout(app, alice).expect(201);
      await http(app).get(`/orders/${order.body.id}`).set(bearer(bob)).expect(404);
    });

    it('requires an Idempotency-Key', async () => {
      const user = await registerUser(app);
      await http(app).post('/checkout').set(bearer(user)).send({}).expect(400);
    });

    it('replays the stored answer when the same key is sent again', async () => {
      const user = await registerUser(app);
      const productId = await createProduct(app, admin, { stock: 5 });
      await addToCart(app, user, productId, 1);
      const key = randomUUID();

      const first = await checkout(app, user, key).expect(201);
      const again = await checkout(app, user, key).expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      expect(await stockOf(app, productId)).toBe(4);
    });

    it('creates one order when a double-click sends the same key five times at once', async () => {
      const user = await registerUser(app);
      const productId = await createProduct(app, admin, { stock: 10 });
      await addToCart(app, user, productId, 1);
      const key = randomUUID();

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => checkout(app, user, key)));
      const created = results.filter((r) => r.status === 201);
      // Each duplicate either waits-and-replays (201 + header) or is told to retry (409).
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
      expect(await stockOf(app, productId)).toBe(9);
      const orders = await http(app).get('/orders').set(bearer(user)).expect(200);
      expect(orders.body.items).toHaveLength(1);
    });

    it('rejects reusing a key for a different request', async () => {
      const user = await registerUser(app);
      const productId = await createProduct(app, admin, { priceCents: 700 });
      await addToCart(app, user, productId, 1);
      const key = randomUUID();
      await checkout(app, user, key).expect(201);
      await checkout(app, user, key, { expectedTotalCents: 700 }).expect(422);
    });

    it('refuses when the total differs from what the customer saw', async () => {
      const user = await registerUser(app);
      const productId = await createProduct(app, admin, { priceCents: 999, stock: 3 });
      await addToCart(app, user, productId, 1);
      const res = await checkout(app, user, randomUUID(), { expectedTotalCents: 500 }).expect(409);
      expect(res.body).toMatchObject({ error: 'price_changed', totalCents: 999 });
      expect(await stockOf(app, productId)).toBe(3);
    });

    it('sells nothing when stock is short, and frees the key for a retry', async () => {
      const user = await registerUser(app);
      const productId = await createProduct(app, admin, { stock: 1 });
      await addToCart(app, user, productId, 2);
      const key = randomUUID();

      const res = await checkout(app, user, key).expect(409);
      expect(res.body).toMatchObject({ error: 'out_of_stock', productId });
      expect(await stockOf(app, productId)).toBe(1);

      await http(app)
        .put(`/inventory/${productId}`)
        .set(bearer(admin))
        .send({ available: 5 })
        .expect(200);
      await checkout(app, user, key).expect(201);
      expect(await stockOf(app, productId)).toBe(3);
    });

    it('takes all lines or none for a multi-product cart', async () => {
      const user = await registerUser(app);
      const plenty = await createProduct(app, admin, { stock: 10 });
      const scarce = await createProduct(app, admin, { stock: 0 });
      await addToCart(app, user, plenty, 1);
      await addToCart(app, user, scarce, 1);

      await checkout(app, user).expect(409);
      expect(await stockOf(app, plenty)).toBe(10);
    });
  });
});

describe.each<StockReservationStrategy>(['atomic', 'locking'])(
  'flash sale with the %s strategy',
  (strategy) => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await startApp('fastify', { LAB_ENDPOINTS: 'true', STOCK_RESERVATION: strategy });
    });

    afterAll(async () => {
      await app.close();
    });

    it('never sells more than the stock when buyers race for the last units', async () => {
      const admin = await registerAdmin(app);
      const productId = await createProduct(app, admin, { stock: 3 });
      const buyers = await Promise.all(Array.from({ length: 12 }, () => registerUser(app)));
      for (const buyer of buyers) await addToCart(app, buyer, productId, 1);

      const results = await Promise.all(buyers.map((b) => checkout(app, b)));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(3);
      expect(statuses.filter((s) => s === 409)).toHaveLength(9);
      expect(await stockOf(app, productId)).toBe(0);
    });
  },
);
