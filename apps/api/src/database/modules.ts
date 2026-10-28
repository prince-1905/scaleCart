import { cartDatabase } from '../cart/cart.database.js';
import { catalogDatabase } from '../catalog/catalog.database.js';
import { identityDatabase } from '../identity/identity.database.js';
import { inventoryDatabase } from '../inventory/inventory.database.js';
import { ordersDatabase } from '../orders/orders.database.js';
import type { ModuleDatabase } from './database.js';

/** Every module's database, for jobs that work on all of them (migrations, health). */
export const MODULE_DATABASES: ModuleDatabase[] = [
  identityDatabase,
  catalogDatabase,
  inventoryDatabase,
  cartDatabase,
  ordersDatabase,
];
