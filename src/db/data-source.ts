import 'reflect-metadata';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { loadEnv } from '../config/env';
import { entities } from './entities';
import { migrations } from './migrations';

const env = loadEnv();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  // A dedicated schema within a shared database (see env.DB_SCHEMA's own comment).
  // TypeORM's own `schema` DataSourceOption only qualifies entity-mapped table names --
  // it never sets search_path on the underlying connection, so a raw queryRunner.query()
  // call (every migration, and row-level-security.ts) would still land in the connection's
  // default schema regardless. Setting it here, as a libpq startup option passed straight
  // through to the pg driver, applies to every query on every connection in the pool,
  // the same mechanism already used for L0-L1-Platform (psycopg2) and scm-lme-backend.
  extra: env.DB_SCHEMA ? { options: `-c search_path=${env.DB_SCHEMA}` } : undefined,
  synchronize: false,
  logging: env.NODE_ENV === 'development',
  entities,
  migrations,
});

/**
 * Creates DB_SCHEMA if it doesn't exist yet. search_path (above) only decides where
 * UNQUALIFIED names resolve -- it doesn't create the schema -- so this has to run
 * before anything else opens AppDataSource. Additive only; every call site
 * (server.ts, migrate.ts, seed-admin.ts, seed-demo.ts) calls this immediately before
 * AppDataSource.initialize().
 *
 * Checks existence first rather than going straight to `CREATE SCHEMA IF NOT EXISTS`:
 * Postgres requires CREATE privilege on the database to even attempt that statement,
 * checked before the IF NOT EXISTS short-circuit -- so on every ordinary app startup,
 * connected as a restricted user that only owns this one schema (not the database),
 * that statement would fail even though the schema already exists and nothing needs
 * creating. information_schema.schemata is readable by any role, so the common case
 * (already exists) never touches a privilege it doesn't have; only the genuine
 * first-ever run, meant to be done once by a sufficiently privileged user, needs it.
 */
export async function ensureSchemaExists(): Promise<void> {
  if (!env.DB_SCHEMA) return;
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
      [env.DB_SCHEMA],
    );
    if (!rowCount) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${env.DB_SCHEMA}"`);
    }
  } finally {
    await client.end();
  }
}
