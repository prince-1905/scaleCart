/**
 * E17 — a redelivery storm against the real worker: the SAME order.created event published COPIES times at once
 * (as a relay crash + retry, or RabbitMQ redelivery, could do), for EVENTS different orders. Then count the
 * confirmation emails per order in Mailpit. Correct = exactly 1 each.
 *
 *   node scripts/e17-email-storm.ts [events=20] [copies=10]
 *
 * The orders are made up (the email worker doesn't look them up); emails go to e17-<run>@test.local in Mailpit only.
 * Runs with plain node from apps/api; reads .env at the repo root.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from 'amqplib';

const ROOT = resolve(import.meta.dirname, '../../..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const EVENTS = Number(process.argv[2] ?? 20);
const COPIES = Number(process.argv[3] ?? 10);
const MAILPIT = 'http://localhost:8025';
const run = randomUUID().slice(0, 8);

const conn = await connect(`amqp://scalecart:${env.RABBITMQ_PASSWORD}@127.0.0.1:5672`);
const ch = await conn.createConfirmChannel();
const orders: string[] = [];
const started = Date.now();
for (let e = 0; e < EVENTS; e++) {
  const orderId = randomUUID();
  orders.push(orderId);
  const event = {
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    orderId,
    userId: randomUUID(),
    email: `e17-${run}@test.local`,
    totalCents: 100,
    items: [{ productId: 1, name: 'E17 storm item', unitPriceCents: 100, quantity: 1 }],
  };
  // All copies back to back: with the worker's prefetch of 20 they are handled at the same time.
  for (let c = 0; c < COPIES; c++) {
    ch.publish('scalecart.events', 'order.created', Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.eventId,
      type: 'order.created',
    });
  }
}
await ch.waitForConfirms();
await conn.close();
console.log(`published ${EVENTS} events × ${COPIES} copies in ${Date.now() - started} ms (run ${run})`);

// Wait until the email count stops changing (retries come back after 5 s).
const count = async (q: string) =>
  ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(q)}&limit=1`)).json()) as { messages_count: number }).messages_count;
let last = -1;
let stable = 0;
for (let waited = 0; stable < 3 && waited < 120; waited += 5) {
  await sleep(5_000);
  const now = await count(`to:e17-${run}@test.local`);
  stable = now === last ? stable + 1 : 0;
  last = now;
}

const perOrder: number[] = [];
for (const id of orders) perOrder.push(await count(`subject:"Order ${id} confirmed"`));
const hist = Object.entries(Object.groupBy(perOrder, (n) => String(n))).map(([n, l]) => `${l!.length} order(s) got ${n}`).join(', ');
console.log(`emails: ${perOrder.reduce((a, b) => a + b, 0)} for ${EVENTS} orders (${hist})`);
console.log(`orders with MORE than one email: ${perOrder.filter((n) => n > 1).length}; with none: ${perOrder.filter((n) => n === 0).length}`);
