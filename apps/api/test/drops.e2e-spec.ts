import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DropPassSigner } from '../src/drops/drop-pass.js';
import { DropsService } from '../src/drops/drops.service.js';
import {
  createProduct,
  dataSource,
  http,
  metric,
  registerAdmin,
  registerUser,
  startApp,
  TEST_ENV,
  type TestUser,
} from './support.js';

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

describe('drops and the waiting room', () => {
  let app: INestApplication;
  let admin: TestUser;

  beforeAll(async () => {
    app = await startApp('fastify');
    admin = await registerAdmin(app);
  });
  afterAll(() => app.close());

  async function newDrop(opts: {
    startsInMs: number;
    stock?: number;
    admitPerSecond?: number;
    maxPerCustomer?: number;
    maxShoppers?: number;
  }) {
    const productId = await createProduct(app, admin, { priceCents: 999_00, stock: opts.stock ?? 100, name: 'Limited sneaker' });
    const res = await http(app)
      .post('/drops')
      .auth(admin.accessToken, { type: 'bearer' })
      .send({
        productId,
        startsAt: iso(opts.startsInMs),
        admitPerSecond: opts.admitPerSecond ?? 1000,
        maxPerCustomer: opts.maxPerCustomer ?? 1,
        maxShoppers: opts.maxShoppers,
      })
      .expect(201);
    return { productId, dropId: res.body.id as number };
  }

  const queue = (user: TestUser, dropId: number, status = 200) =>
    http(app).post(`/drops/${dropId}/queue`).auth(user.accessToken, { type: 'bearer' }).expect(status);

  async function buy(user: TestUser, productId: number, dropPass?: string, { quantity = 1, key = randomUUID() } = {}) {
    await http(app).put(`/cart/items/${productId}`).auth(user.accessToken, { type: 'bearer' }).send({ quantity }).expect(200);
    return http(app)
      .post('/checkout')
      .auth(user.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send(dropPass ? { dropPass } : {});
  }

  it('only admins create drops; anyone can see them, with the server clock', async () => {
    const customer = await registerUser(app);
    const productId = await createProduct(app, admin, { stock: 5 });
    await http(app).post('/drops').auth(customer.accessToken, { type: 'bearer' }).send({ productId, startsAt: iso(60_000) }).expect(403);

    const { dropId } = await newDrop({ startsInMs: 60_000 });
    const res = await http(app).get(`/drops/${dropId}`).expect(200);
    expect(res.body).toMatchObject({ id: dropId, status: 'upcoming', maxPerCustomer: 1, available: 100 });
    expect(Date.parse(res.body.serverTime)).toBeGreaterThan(0);
    expect((await http(app).get('/drops').expect(200)).body.some((d: { id: number }) => d.id === dropId)).toBe(true);
  });

  it('before the start: the line opens 10 min early, checkout is refused', async () => {
    const user = await registerUser(app);
    const far = await newDrop({ startsInMs: 30 * 60_000 });
    expect((await queue(user, far.dropId, 409)).body.error).toBe('queue_not_open');

    const soon = await newDrop({ startsInMs: 60_000 });
    const status = (await queue(user, soon.dropId)).body;
    expect(status).toMatchObject({ ticket: 1, admitted: false, admittedUpTo: 0, position: 1 });
    expect(status.pass).toBeUndefined();
    expect(status.etaSeconds).toBeGreaterThanOrEqual(59);

    const res = await buy(user, soon.productId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('drop_not_started');
  });

  it('one ticket per customer, however often they ask; parallel joiners get distinct numbers', async () => {
    const { dropId } = await newDrop({ startsInMs: 60_000 });
    const users = await Promise.all(Array.from({ length: 20 }, () => registerUser(app)));
    const tickets = await Promise.all(users.map(async (u) => (await queue(u, dropId)).body.ticket as number));
    expect(new Set(tickets).size).toBe(20);
    expect([...tickets].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // Asking again (refresh, second tab) keeps the same place.
    expect((await queue(users[0], dropId)).body.ticket).toBe(tickets[0]);
  });

  it('the line moves at the admit rate: first ticket called, second still waiting', async () => {
    // Started 1.1 s ago at 1 ticket per second: ticket 1 is called, ticket 2 waits until the 2 s mark.
    // Users are registered first (Argon2 is slow), so both queue calls land well inside that window.
    const [u1, u2] = await Promise.all([registerUser(app), registerUser(app)]);
    const { dropId } = await newDrop({ startsInMs: -1_100, admitPerSecond: 1 });
    const first = (await queue(u1, dropId)).body;
    const second = (await queue(u2, dropId)).body;
    expect(first).toMatchObject({ ticket: 1, admitted: true, position: 0 });
    expect(first.pass).toEqual(expect.any(String));
    expect(second).toMatchObject({ ticket: 2, admitted: false, position: 1, etaSeconds: 1 });
  });

  it('a live drop needs a pass; with it, one purchase per customer within the limit', async () => {
    const { dropId, productId } = await newDrop({ startsInMs: -1_000, maxPerCustomer: 1 });
    const user = await registerUser(app);

    const noPass = await buy(user, productId);
    expect(noPass.status).toBe(403);
    expect(noPass.body.error).toBe('drop_pass_required');

    const { pass } = (await queue(user, dropId)).body;
    const tooMany = await buy(user, productId, pass, { quantity: 2 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toBe('drop_limit');

    expect((await buy(user, productId, pass)).status).toBe(201);

    const again = await buy(user, productId, (await queue(user, dropId)).body.pass);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('drop_already_bought');
  });

  it('a valid pass wins over the clock (the server clock can jump back after the pass was issued)', async () => {
    // The drop "starts in 2 s" by this clock, yet the buyer holds a genuine pass, as happens
    // when the clock is stepped back right after their ticket was called.
    const { dropId, productId } = await newDrop({ startsInMs: 2_000 });
    const user = await registerUser(app);
    const me = (await http(app).get('/auth/me').auth(user.accessToken, { type: 'bearer' }).expect(200)).body;
    const pass = new DropPassSigner(TEST_ENV.JWT_SECRET!).sign({ d: dropId, u: me.id, t: 1, exp: Date.now() + 60_000 });

    expect((await buy(user, productId)).body.error).toBe('drop_not_started'); // no pass: the clock decides
    expect((await buy(user, productId, pass)).status).toBe(201);
  });

  it("someone else's pass, or a forged one, doesn't work", async () => {
    const { dropId, productId } = await newDrop({ startsInMs: -1_000 });
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const alicesPass = (await queue(alice, dropId)).body.pass;

    expect((await buy(bob, productId, alicesPass)).status).toBe(403);
    const forged = new DropPassSigner('guessed-secret-0123456789-0123456').sign({ d: dropId, u: 'x', t: 1, exp: Date.now() + 60_000 });
    expect((await buy(bob, productId, forged)).status).toBe(403);
  });

  it('a retry of the same checkout with a refreshed pass is a replay, not a second purchase', async () => {
    const { dropId, productId } = await newDrop({ startsInMs: -1_000 });
    const user = await registerUser(app);
    const key = randomUUID();
    const first = await buy(user, productId, (await queue(user, dropId)).body.pass, { key });
    expect(first.status).toBe(201);

    const retry = await http(app)
      .post('/checkout')
      .auth(user.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ dropPass: (await queue(user, dropId)).body.pass });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
  });

  it('"Buy now" buys only the drop item: the rest of the cart is neither bought nor touched, even when it fails', async () => {
    const { dropId, productId } = await newDrop({ startsInMs: -1_000, stock: 1 });
    const other = await createProduct(app, admin, { stock: 5, priceCents: 300_00 });
    const [user, rival] = [await registerUser(app), await registerUser(app)];
    const cartOf = async (u: TestUser) =>
      (await http(app).get('/cart').auth(u.accessToken, { type: 'bearer' }).expect(200)).body.items.map(
        (i: { productId: number; quantity: number }) => `${i.productId}x${i.quantity}`,
      );
    const buyNow = (u: TestUser, pass: string) =>
      http(app)
        .post('/checkout')
        .auth(u.accessToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ dropPass: pass, buyNow: { productId, quantity: 1 } });
    for (const u of [user, rival]) {
      await http(app).put(`/cart/items/${other}`).auth(u.accessToken, { type: 'bearer' }).send({ quantity: 2 }).expect(200);
    }
    const [userPass, rivalPass] = [(await queue(user, dropId)).body.pass, (await queue(rival, dropId)).body.pass];

    const res = await buyNow(user, userPass).expect(201);
    expect(res.body.items).toEqual([expect.objectContaining({ productId, quantity: 1 })]);
    expect(res.body.totalCents).toBe(999_00);
    expect(await cartOf(user)).toEqual([`${other}x2`]);
    expect((await http(app).get(`/inventory/${other}`)).body.available).toBe(5);

    // Sold out now: the rival's attempt fails and leaves no drop item behind in their cart.
    expect((await buyNow(rival, rivalPass)).status).toBe(409);
    expect(await cartOf(rival)).toEqual([`${other}x2`]);
  });

  it('sold out: the losing buyer keeps their right to buy (claim released)', async () => {
    const { dropId, productId } = await newDrop({ startsInMs: -1_000, stock: 1 });
    const winner = await registerUser(app);
    const loser = await registerUser(app);
    // Both are called while there's still stock; the winner checks out first.
    const winnerPass = (await queue(winner, dropId)).body.pass;
    const loserPass = (await queue(loser, dropId)).body.pass;
    expect((await buy(winner, productId, winnerPass)).status).toBe(201);

    const res = await buy(loser, productId, loserPass);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('out_of_stock');
    const rows = await dataSource(app, 'drops').query('SELECT 1 FROM drop_purchases WHERE drop_id = ? AND user_id = ?', [
      dropId,
      (await http(app).get('/auth/me').auth(loser.accessToken, { type: 'bearer' })).body.id ?? '',
    ]);
    expect(rows).toHaveLength(0);
  });

  it('once sold out, the line closes: no ticket, no "your turn"; it reopens if stock comes back', async () => {
    const { dropId, productId } = await newDrop({ startsInMs: -1_000, stock: 1 });
    const [first, late] = await Promise.all([registerUser(app), registerUser(app)]);
    expect((await buy(first, productId, (await queue(first, dropId)).body.pass)).status).toBe(201);

    const closed = (await queue(late, dropId)).body;
    expect(closed).toMatchObject({ soldOut: true, admitted: false, ticket: 0 });
    expect(closed.pass).toBeUndefined();

    // An unpaid order expires and its unit goes back: after the counter's reset, the line is open again.
    await http(app).put(`/inventory/${productId}`).auth(admin.accessToken, { type: 'bearer' }).send({ available: 1 }).expect(200);
    await app.get(DropsService).resetGates();
    const reopened = (await queue(late, dropId)).body;
    expect(reopened.soldOut).toBeUndefined();
    expect(reopened.admitted).toBe(true);
  });

  describe('"one out, one in" (maxShoppers)', () => {
    it('2 places: A and B get in, C waits; when A buys, C gets in', async () => {
      const { dropId, productId } = await newDrop({ startsInMs: -1_000, maxShoppers: 2 });
      const [a, b, c] = await Promise.all([registerUser(app), registerUser(app), registerUser(app)]);

      const sa = (await queue(a, dropId)).body;
      const sb = (await queue(b, dropId)).body;
      const sc = (await queue(c, dropId)).body;
      expect(sa).toMatchObject({ ticket: 1, admitted: true });
      expect(sb).toMatchObject({ ticket: 2, admitted: true });
      expect(sc).toMatchObject({ ticket: 3, admitted: false, position: 1 });
      // The pass lasts as long as the place (60 s), not 5 minutes.
      expect(Date.parse(sa.passExpiresAt) - Date.now()).toBeLessThanOrEqual(60_000);

      // Asking again doesn't change anything while nobody has finished.
      expect((await queue(c, dropId)).body.admitted).toBe(false);

      expect((await buy(a, productId, sa.pass)).status).toBe(201);
      const after = (await queue(c, dropId)).body;
      expect(after).toMatchObject({ ticket: 3, admitted: true, admittedUpTo: 3 });
      expect((await buy(c, productId, after.pass)).status).toBe(201);
    });

    it('two called buyers, one unit: the second checkout gets "sold out"', async () => {
      const { dropId, productId } = await newDrop({ startsInMs: -1_000, maxShoppers: 2, stock: 1 });
      const [a, b] = await Promise.all([registerUser(app), registerUser(app)]);
      const sa = (await queue(a, dropId)).body;
      const sb = (await queue(b, dropId)).body;
      expect(sb.admitted).toBe(true);
      expect((await buy(a, productId, sa.pass)).status).toBe(201);
      expect((await buy(b, productId, sb.pass)).body.error).toBe('out_of_stock');
    });

    it('before the start, nobody is called', async () => {
      const { dropId } = await newDrop({ startsInMs: 60_000, maxShoppers: 5 });
      expect((await queue(await registerUser(app), dropId)).body).toMatchObject({ ticket: 1, admitted: false, admittedUpTo: 0 });
    });
  });

  describe('the Redis door counter (stock gate)', () => {
    const gateCount = (result: string) => metric(app, new RegExp(`drop_stock_gate_total\\{result="${result}"\\} (\\d+)`));

    it('once it reaches 0, buyers get "sold out" without going to the MySQL stock row', async () => {
      const { dropId, productId } = await newDrop({ startsInMs: -1_000, stock: 2 });
      const buyers = await Promise.all([registerUser(app), registerUser(app), registerUser(app)]);
      const soldOutBefore = await gateCount('sold_out');

      // All three are called while stock remains (once sold out, the line hands out no passes).
      const passes = [];
      for (const b of buyers) passes.push((await queue(b, dropId)).body.pass);
      for (const i of [0, 1]) expect((await buy(buyers[i], productId, passes[i])).status).toBe(201);
      const pass = passes[2];

      // Jam the MySQL stock row (like a stuck commit). Without the gate, the third checkout would
      // wait for this lock; with it, "sold out" comes back without touching the row.
      const jam = dataSource(app, 'inventory').createQueryRunner();
      await jam.connect();
      await jam.startTransaction();
      await jam.query('SELECT available FROM stock WHERE product_id = ? FOR UPDATE', [productId]);
      const started = performance.now();
      const third = await buy(buyers[2], productId, pass);
      const ms = performance.now() - started;
      await jam.rollbackTransaction();
      await jam.release();

      expect(third.status).toBe(409);
      expect(third.body.error).toBe('out_of_stock');
      expect(ms).toBeLessThan(2_000);
      expect(await gateCount('sold_out')).toBe(soldOutBefore + 1);
    });

    it('a wrong counter still cannot oversell (MySQL decides), and the reset corrects it', async () => {
      const { dropId, productId } = await newDrop({ startsInMs: -1_000, stock: 5 });
      const [a, b, c] = await Promise.all([registerUser(app), registerUser(app), registerUser(app)]);
      const cPass = (await queue(c, dropId)).body.pass; // called while stock remains
      expect((await buy(a, productId, (await queue(a, dropId)).body.pass)).status).toBe(201); // counter: 4

      // Stock changes behind the counter's back: MySQL now says 0, the counter still says 4.
      await http(app).put(`/inventory/${productId}`).auth(admin.accessToken, { type: 'bearer' }).send({ available: 0 }).expect(200);
      const takenBefore = await gateCount('taken');
      const second = await buy(b, productId, (await queue(b, dropId)).body.pass);
      expect(second.body.error).toBe('out_of_stock'); // the gate let b try; MySQL said no
      expect(await gateCount('taken')).toBe(takenBefore + 1);

      await app.get(DropsService).resetGates(); // counter := MySQL's 0
      const soldOutBefore = await gateCount('sold_out');
      expect((await buy(c, productId, cPass)).body.error).toBe('out_of_stock');
      expect(await gateCount('sold_out')).toBe(soldOutBefore + 1); // answered by the gate this time
      expect((await http(app).get(`/inventory/${productId}`)).body.available).toBe(0);
    });
  });

  it('normal products are not affected by drops', async () => {
    const user = await registerUser(app);
    const productId = await createProduct(app, admin, { stock: 5 });
    expect((await buy(user, productId)).status).toBe(201);
  });

  describe('admin tools', () => {
    it("staff can't join a drop's line, but can still buy normal products", async () => {
      const { dropId } = await newDrop({ startsInMs: -1_000 });
      expect((await queue(admin, dropId, 403)).body.error).toBe('staff_cannot_join_drops');
      const productId = await createProduct(app, admin, { stock: 5 });
      expect((await buy(admin, productId)).status).toBe(201);
    });

    it('admins edit a drop (customers get 403); maxShoppers null switches back to the timed line', async () => {
      const customer = await registerUser(app);
      const { dropId } = await newDrop({ startsInMs: 60_000, maxShoppers: 3 });
      await http(app).patch(`/drops/${dropId}`).auth(customer.accessToken, { type: 'bearer' }).send({ maxPerCustomer: 2 }).expect(403);

      const startsAt = iso(120_000);
      const res = await http(app)
        .patch(`/drops/${dropId}`)
        .auth(admin.accessToken, { type: 'bearer' })
        .send({ name: 'Renamed drop', startsAt, maxPerCustomer: 2, maxShoppers: null })
        .expect(200);
      expect(res.body).toMatchObject({ id: dropId, name: 'Renamed drop', startsAt, maxPerCustomer: 2, maxShoppers: null });
      // Untouched fields stay; an empty edit changes nothing.
      const same = await http(app).patch(`/drops/${dropId}`).auth(admin.accessToken, { type: 'bearer' }).send({}).expect(200);
      expect(same.body).toMatchObject({ name: 'Renamed drop', admitPerSecond: 1000 });
      await http(app).patch('/drops/999999').auth(admin.accessToken, { type: 'bearer' }).send({ maxPerCustomer: 2 }).expect(404);
    });

    it('a drop can be cancelled only while nobody has bought in it', async () => {
      const empty = await newDrop({ startsInMs: 60_000 });
      await http(app).delete(`/drops/${empty.dropId}`).auth(admin.accessToken, { type: 'bearer' }).expect(204);
      await http(app).get(`/drops/${empty.dropId}`).expect(404);

      const sold = await newDrop({ startsInMs: -1_000 });
      const user = await registerUser(app);
      expect((await buy(user, sold.productId, (await queue(user, sold.dropId)).body.pass)).status).toBe(201);
      const res = await http(app).delete(`/drops/${sold.dropId}`).auth(admin.accessToken, { type: 'bearer' }).expect(409);
      expect(res.body.error).toBe('drop_has_orders');
      await http(app).delete(`/drops/${sold.dropId}`).auth(user.accessToken, { type: 'bearer' }).expect(403);
    });

    it('the live monitor counts the line, purchases and stock left', async () => {
      const { dropId, productId } = await newDrop({ startsInMs: -1_000, stock: 10 });
      const [a, b] = [await registerUser(app), await registerUser(app)];
      await queue(a, dropId);
      expect((await buy(b, productId, (await queue(b, dropId)).body.pass)).status).toBe(201);

      const customer = await registerUser(app);
      await http(app).get(`/drops/${dropId}/stats`).auth(customer.accessToken, { type: 'bearer' }).expect(403);
      const stats = (await http(app).get(`/drops/${dropId}/stats`).auth(admin.accessToken, { type: 'bearer' }).expect(200)).body;
      expect(stats).toMatchObject({ dropId, ticketsIssued: 2, calledUpTo: 2, inLine: 0, purchases: 1, available: 9 });
    });
  });
});

describe('drops when Redis is down', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Nothing listens there: Redis is "down" for this app.
    app = await startApp('fastify', { REDIS_URL: 'redis://127.0.0.1:6390/1' });
  });
  afterAll(() => app.close());

  it('the line pauses (503), but a pass already issued still works: verifying it needs no Redis', async () => {
    const admin = await registerAdmin(app);
    const user = await registerUser(app);
    const productId = await createProduct(app, admin, { stock: 5 });
    const drop = (
      await http(app).post('/drops').auth(admin.accessToken, { type: 'bearer' }).send({ productId, startsAt: iso(-1_000) }).expect(201)
    ).body;

    const queued = await http(app).post(`/drops/${drop.id}/queue`).auth(user.accessToken, { type: 'bearer' }).expect(503);
    expect(queued.body.error).toBe('waiting_room_unavailable');

    // A pass issued before Redis went down (signed the same way the app signs them).
    const me = (await http(app).get('/auth/me').auth(user.accessToken, { type: 'bearer' }).expect(200)).body;
    const pass = new DropPassSigner(TEST_ENV.JWT_SECRET!).sign({ d: drop.id, u: me.id, t: 1, exp: Date.now() + 60_000 });
    await http(app).put(`/cart/items/${productId}`).auth(user.accessToken, { type: 'bearer' }).send({ quantity: 1 }).expect(200);
    await http(app)
      .post('/checkout')
      .auth(user.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ dropPass: pass })
      .expect(201);
  });
});
