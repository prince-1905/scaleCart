import type { ModuleDatabase } from '../database/database.js';
import { IdempotencyKey } from './idempotency-key.entity.js';
import { OrdersInit1793059200000 } from './migrations/1793059200000-orders-init.js';
import { Outbox1793145600000 } from './migrations/1793145600000-outbox.js';
import { Order, OrderItem } from './order.entity.js';
import { OutboxEvent } from './outbox.entity.js';

export const ordersDatabase: ModuleDatabase = {
  module: 'orders',
  entities: [Order, OrderItem, IdempotencyKey, OutboxEvent],
  migrations: [OrdersInit1793059200000, Outbox1793145600000],
};
