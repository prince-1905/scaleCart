import type { ModuleDatabase } from '../database/database.js';
import { CatalogInit1793059200000 } from './migrations/1793059200000-catalog-init.js';
import { Product } from './product.entity.js';

export const catalogDatabase: ModuleDatabase = {
  module: 'catalog',
  entities: [Product],
  migrations: [CatalogInit1793059200000],
};
