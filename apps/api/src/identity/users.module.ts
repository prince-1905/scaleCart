import { Module } from '@nestjs/common';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { identityDatabase } from './identity.database.js';
import { UserDirectory } from './user-directory.js';

/**
 * Identity's data access, without the HTTP side (login endpoints, guard, JWT).
 * The worker imports only this; the API's IdentityModule builds on it.
 */
@Module({
  imports: [...moduleTypeOrm(identityDatabase)],
  providers: [UserDirectory],
  exports: [UserDirectory],
})
export class UsersModule {}
