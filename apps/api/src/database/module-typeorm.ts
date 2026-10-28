import { TypeOrmModule } from '@nestjs/typeorm';
import { ENV, type Env } from '../config/env.js';
import { mysqlOptions, type ModuleDatabase } from './database.js';

/**
 * A module's own connection pool plus its repositories. Inject them with the module
 * name, e.g. `@InjectRepository(Product, 'catalog')` or `@InjectDataSource('catalog')`.
 */
export function moduleTypeOrm(def: ModuleDatabase) {
  return [
    TypeOrmModule.forRootAsync({
      name: def.module,
      inject: [ENV],
      useFactory: (env: Env) => ({
        ...mysqlOptions(env.db, def),
        retryAttempts: 5,
        retryDelay: 2_000,
      }),
    }),
    TypeOrmModule.forFeature(def.entities as Function[], def.module),
  ];
}
