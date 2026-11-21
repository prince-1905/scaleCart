import { cartDatabase } from '../cart/cart.database.js';
import { catalogDatabase } from '../catalog/catalog.database.js';
import { inventoryDatabase } from '../inventory/inventory.database.js';
import { notificationsDatabase } from '../notifications/notifications.database.js';
import { ordersDatabase } from '../orders/orders.database.js';
import { dropsDatabase } from '../drops/drops.database.js';
import type { ModuleDatabase, ModuleName } from './database.js';

/**
 * Every module's database, for jobs that work on all of them (migrations). scalecart_payments (Phase 8) and
 * scalecart_identity (Phase 11) are not here any more: they belong to their own services (apps/payments,
 * apps/identity), which migrate them themselves.
 */
export const MODULE_DATABASES: ModuleDatabase[] = [
  catalogDatabase,
  inventoryDatabase,
  cartDatabase,
  ordersDatabase,
  notificationsDatabase,
  dropsDatabase,
];

/** The databases the API process connects to (notifications is worker-only). */
export const API_DATABASES: ModuleName[] = ['catalog', 'inventory', 'cart', 'orders', 'drops'];
