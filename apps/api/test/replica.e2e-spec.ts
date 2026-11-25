import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createConnection, type Connection } from 'mysql2/promise';
import { ReadReplica } from '../src/database/read-replica.js';
import { ReplicationHeartbeat } from '../src/orders/replication-heartbeat.js';
import { createProduct, dataSource, eventually, http, metric, registerAdmin, registerUser, startApp, type TestUser } from './support.js';

/**
 * Phase 13: the read replica. Runs against the Compose replica (mysql-replica, localhost:3308), which copies the
 * whole primary, the scalecart_test_* databases included. Pausing the replica's applier (STOP REPLICA SQL_THREAD)
 * makes it fall behind on purpose; it is always started again. The real heartbeat writer (normally in the worker)
 * stamps the test database every 250 ms, so "how far behind" is real.
 */
const REPLICA_PORT = process.env.MYSQL_REPLICA_PORT ?? '3308';
const ON_REPLICA = { DB_READ_HOST: '127.0.0.1', DB_READ_PORT: REPLICA_PORT };
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });
const reads = (module: string, target: string, reason: string) =>
  new RegExp(`db_routed_reads_total\\{module="${module}",target="${target}",reason="${reason}"\\} (\\d+)`);

/** All reads of a module that went to `target`, whatever the reason (under load the reason may be "down"/"lagging"). */
async function readsTo(app: INestApplication, module: string, target: string): Promise<number> {
  const text = (await http(app).get('/metrics').expect(200)).text;
  const re = new RegExp(`^db_routed_reads_total\\{module="${module}",target="${target}",reason="[a-z_]+"\\} (\\d+)$`, 'gm');
  return [...text.matchAll(re)].reduce((sum, m) => sum + Number(m[1]), 0);
}

describe('read replica (Phase 13)', () => {
  let replicaRoot: Connection;
  let app: INestApplication;
  let admin: TestUser;
  let heartbeat: ReplicationHeartbeat;

  const stateOf = (a: INestApplication) => a.get(ReadReplica).current.state;
  const pauseReplica = () => replicaRoot.query('STOP REPLICA SQL_THREAD');
  const resumeReplica = () => replicaRoot.query('START REPLICA SQL_THREAD');

  beforeAll(async () => {
    replicaRoot = await createConnection({ host: '127.0.0.1', port: Number(REPLICA_PORT), user: 'root', password: process.env.MYSQL_ROOT_PASSWORD });
    await resumeReplica();
    // A generous lag limit here: only the "too far behind" test uses a small one.
    app = await startApp('fastify', { ...ON_REPLICA, READ_REPLICA_MAX_LAG_SECONDS: '3600' });
    heartbeat = new ReplicationHeartbeat(dataSource(app, 'orders'));
    heartbeat.onModuleInit();
    await eventually(async () => stateOf(app) === 'ok');
    admin = await registerAdmin(app);
  });

  afterAll(async () => {
    heartbeat?.onApplicationShutdown();
    await resumeReplica().catch(() => {});
    await replicaRoot?.end();
    await app?.close();
  });

  it('browsing reads (product list, admin dashboard) go to the replica', async () => {
    await eventually(async () => stateOf(app) === 'ok');
    const products = await metric(app, reads('catalog', 'replica', 'healthy'));
    const orders = await metric(app, reads('orders', 'replica', 'healthy'));
    await http(app).get('/products?limit=5').expect(200);
    await http(app).get('/admin/orders/stats').set(bearer(admin)).expect(200);
    expect(await metric(app, reads('catalog', 'replica', 'healthy'))).toBe(products + 1);
    expect(await metric(app, reads('orders', 'replica', 'healthy'))).toBe(orders + 1);
  });

  it('read-your-writes: an order placed while the replica is behind is still in "My orders" (from the primary)', async () => {
    const buyer = await registerUser(app);
    const someoneElse = await registerUser(app);
    const productId = await createProduct(app, admin, { stock: 5 });
    await http(app).put(`/cart/items/${productId}`).set(bearer(buyer)).send({ quantity: 1 }).expect(200);

    await pauseReplica();
    try {
      const order = await http(app).post('/checkout').set(bearer(buyer)).set('Idempotency-Key', randomUUID()).send({}).expect(201);
      // The replica really doesn't have it: a plain replica read would have shown an empty order list.
      const [onReplica] = (await replicaRoot.query('SELECT COUNT(*) AS n FROM scalecart_test_orders.orders WHERE id = ?', [order.body.id])) as unknown as [{ n: number }[]];
      expect(Number(onReplica[0].n)).toBe(0);

      // Both of the buyer's reads come from the primary (normally reason "ryw_not_yet"; under heavy load the replica
      // may also count as down or lagging, which routes to the primary as well).
      const fromPrimary = await readsTo(app, 'orders', 'primary');
      const mine = await http(app).get('/orders').set(bearer(buyer)).expect(200);
      expect(mine.body.items.map((o: { id: string }) => o.id)).toContain(order.body.id);
      await http(app).get(`/orders/${order.body.id}`).set(bearer(buyer)).expect(200);
      expect(await readsTo(app, 'orders', 'primary')).toBe(fromPrimary + 2);

      // A customer without a recent write still reads the replica.
      await eventually(async () => stateOf(app) === 'ok');
      const others = await metric(app, reads('orders', 'replica', 'healthy'));
      await http(app).get('/orders').set(bearer(someoneElse)).expect(200);
      expect(await metric(app, reads('orders', 'replica', 'healthy'))).toBe(others + 1);
    } finally {
      await resumeReplica();
    }

    // Caught up again: the buyer's reads wait for the replica to have the order, then use it.
    await eventually(async () => {
      const before = await metric(app, reads('orders', 'replica', 'ryw_caught_up'));
      const mine = await http(app).get('/orders').set(bearer(buyer)).expect(200);
      return mine.body.items.length === 1 && (await metric(app, reads('orders', 'replica', 'ryw_caught_up'))) === before + 1;
    });
  });

  it('too far behind → reads go to the primary until it catches up', async () => {
    // 2 s, not 1: during a full parallel test run the replica really falls more than 1 s behind at times.
    const strict = await startApp('fastify', { ...ON_REPLICA, READ_REPLICA_MAX_LAG_SECONDS: '2' });
    try {
      await eventually(async () => stateOf(strict) === 'ok', 30_000);
      await pauseReplica();
      try {
        await eventually(async () => stateOf(strict) === 'lagging', 15_000);
        const before = await readsTo(strict, 'catalog', 'primary');
        const fromReplica = await readsTo(strict, 'catalog', 'replica');
        await http(strict).get('/products?limit=5').expect(200);
        expect(await readsTo(strict, 'catalog', 'primary')).toBe(before + 1);
        expect(await readsTo(strict, 'catalog', 'replica')).toBe(fromReplica);
      } finally {
        await resumeReplica();
      }
      await eventually(async () => stateOf(strict) === 'ok', 30_000);
    } finally {
      await strict.close();
    }
  });

  it('replica unusable → only a few of its reads run on the primary at once; the rest get a quick 503 (bulkhead)', async () => {
    const limited = await startApp('fastify', { DB_READ_HOST: '127.0.0.1', DB_READ_PORT: '1', READ_FALLBACK_CONCURRENCY: '1' });
    try {
      await eventually(async () => stateOf(limited) === 'down');
      const staff = await registerAdmin(limited);
      const answers = await Promise.all(
        Array.from({ length: 40 }, () => http(limited).get('/admin/orders/stats').set(bearer(staff))),
      );
      const statuses = answers.map((r) => r.status);
      expect(statuses).toContain(200);
      expect(statuses).toContain(503);
      expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
      expect(answers.find((r) => r.status === 503)!.body.error).toBe('read_busy');
    } finally {
      await limited.close();
    }
  });

  it('replica unreachable → reads still answer, from the primary; the API starts anyway', async () => {
    const broken = await startApp('fastify', { DB_READ_HOST: '127.0.0.1', DB_READ_PORT: '1' });
    try {
      await eventually(async () => stateOf(broken) === 'down');
      const user = await registerUser(broken);
      await http(broken).get('/products?limit=5').expect(200);
      await http(broken).get('/orders').set(bearer(user)).expect(200);
      expect(await metric(broken, reads('catalog', 'primary', 'down'))).toBeGreaterThanOrEqual(1);
      expect(await metric(broken, reads('orders', 'primary', 'down'))).toBeGreaterThanOrEqual(1);
    } finally {
      await broken.close();
    }
    await sleep(0);
  });
});
