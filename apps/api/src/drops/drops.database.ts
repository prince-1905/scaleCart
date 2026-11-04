import type { ModuleDatabase } from '../database/database.js';
import { Drop, DropPurchase } from './drop.entities.js';
import { DropsInit1793404800000 } from './migrations/1793404800000-drops-init.js';
import { DropMaxShoppers1793491200000 } from './migrations/1793491200000-drop-max-shoppers.js';

export const dropsDatabase: ModuleDatabase = {
  module: 'drops',
  entities: [Drop, DropPurchase],
  migrations: [DropsInit1793404800000, DropMaxShoppers1793491200000],
};
