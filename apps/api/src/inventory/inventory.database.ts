import type { ModuleDatabase } from '../database/database.js';
import { InventoryInit1793059200000 } from './migrations/1793059200000-inventory-init.js';
import { Reservation } from './reservation.entity.js';
import { Stock } from './stock.entity.js';

export const inventoryDatabase: ModuleDatabase = {
  module: 'inventory',
  entities: [Stock, Reservation],
  migrations: [InventoryInit1793059200000],
};
