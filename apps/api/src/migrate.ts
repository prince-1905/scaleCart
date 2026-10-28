import { loadDbConfig } from './config/env.js';
import { migrateAll } from './database/migrate.js';

// Entry point of the one-off migration job: `node dist/migrate.js`
await migrateAll(loadDbConfig(), { log: (line) => console.log(line) });
