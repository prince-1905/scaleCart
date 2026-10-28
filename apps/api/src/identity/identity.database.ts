import type { ModuleDatabase } from '../database/database.js';
import { IdentityInit1793059200000 } from './migrations/1793059200000-identity-init.js';
import { RefreshToken } from './refresh-token.entity.js';
import { User } from './user.entity.js';

export const identityDatabase: ModuleDatabase = {
  module: 'identity',
  entities: [User, RefreshToken],
  migrations: [IdentityInit1793059200000],
};
