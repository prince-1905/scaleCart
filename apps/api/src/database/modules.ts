import { cartDatabase } from '../cart/cart.database.js';
import { catalogDatabase } from '../catalog/catalog.database.js';
import { identityDatabase } from '../identity/identity.database.js';
import { inventoryDatabase } from '../inventory/inventory.database.js';
import { notificationsDatabase } from '../notifications/notifications.database.js';
import { ordersDatabase } from '../orders/orders.database.js';
import type { ModuleDatabase, ModuleName } from './database.js';

/** Every module's database, for jobs that work on all of them (migrations). */
export const MODULE_DATABASES: ModuleDatabase[] = [
  identityDatabase,
  catalogDatabase,
  inventoryDatabase,
  cartDatabase,
  ordersDatabase,
  notificationsDatabase,
];

/** The databases the API process connects to (notifications is worker-only). */
export const API_DATABASES: ModuleName[] = ['identity', 'catalog', 'inventory', 'cart', 'orders'];
