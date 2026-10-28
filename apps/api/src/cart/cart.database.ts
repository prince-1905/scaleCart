import type { ModuleDatabase } from '../database/database.js';
import { CartItem } from './cart-item.entity.js';
import { CartInit1793059200000 } from './migrations/1793059200000-cart-init.js';

export const cartDatabase: ModuleDatabase = {
  module: 'cart',
  entities: [CartItem],
  migrations: [CartInit1793059200000],
};
