import { createConnection } from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { loadDbConfig } from '../src/config/env.js';
import { mysqlOptions } from '../src/database/database.js';
import { TEST_ENV } from './support.js';

/** Fresh state for every run: recreate and migrate this service's test database. */
export default async function setup() {
  const db = loadDbConfig(TEST_ENV);
  const admin = await createConnection({ host: db.host, port: db.port, user: db.user, password: db.password });
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${db.database}\``);
    await admin.query(`CREATE DATABASE \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await admin.end();
  }
  const ds = new DataSource(mysqlOptions(db, 1));
  await ds.initialize();
  try {
    await ds.runMigrations();
  } finally {
    await ds.destroy();
  }
}
