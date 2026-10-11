import type { DataSource } from 'typeorm';
import { currentDbContext, type DbContext } from './request-context';

/** The restricted role the row-level security policies are written for (see migration 1700000016000). */
export const APP_DB_ROLE = 'lcms_app';

type PgClient = { query: (text: string, values?: unknown[]) => Promise<unknown> } & { __lcmsDbKey?: string };
type PgConnectCallback = (error: Error | undefined, client?: PgClient, release?: (error?: Error | boolean) => void) => void;
type PgPool = { connect: (callback?: PgConnectCallback) => unknown };

const installed = new WeakSet<DataSource>();

/** What a connection must look like for this request: restricted (as which user), or unrestricted. */
function keyFor(context: DbContext | undefined): string {
  if (!context) {
    return 'system';
  }
  return `user:${context.userId ?? ''}`;
}

/**
 * Put a pooled connection into the state a request needs before it runs any query. A connection
 * is reused across requests, so this always makes the state explicit, and skips the round trips
 * only when the connection already holds exactly that state.
 */
async function applyContext(client: PgClient, context: DbContext | undefined): Promise<void> {
  const key = keyFor(context);
  if (client.__lcmsDbKey === key) {
    return;
  }
  // Forget the old state first: if a step below fails the connection must not look "already set".
  client.__lcmsDbKey = undefined;
  if (!context) {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('app.user_id', '', false)`);
  } else {
    await client.query(`SELECT set_config('app.user_id', $1, false)`, [context.userId ?? '']);
    await client.query(`SET ROLE ${APP_DB_ROLE}`);
  }
  client.__lcmsDbKey = key;
}

async function policiesAreInstalled(dataSource: DataSource): Promise<boolean> {
  const rows = (await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
            AND to_regprocedure('app_current_user_id()') IS NOT NULL AS installed`,
    [APP_DB_ROLE],
  )) as { installed: boolean }[];
  return rows[0]?.installed === true;
}

/**
 * Turn on row-level security for everything this DataSource does inside a request (BRD AC-03).
 *
 * Every time the pool hands out a connection, the acting user of the request that asked for it is
 * written onto the connection (`app.user_id`) and the connection is switched to the restricted
 * role, so Postgres itself decides which rows that user may read or write. The user comes from
 * AsyncLocalStorage and is captured when the connection is requested, not when it is handed over:
 * a waiting request can be served by a connection released from a different request.
 *
 * If the database has not been migrated yet the policies do not exist and `SET ROLE` would fail on
 * every query. That is refused when `required` (production) and otherwise logged and skipped, so a
 * developer who has pulled the code but not run the migration still has a working app.
 */
export async function installRowLevelSecurity(
  dataSource: DataSource,
  options: { required: boolean; warn?: (message: string) => void } = { required: false },
): Promise<boolean> {
  if (installed.has(dataSource)) {
    return true;
  }
  if (!(await policiesAreInstalled(dataSource))) {
    const message =
      'Row-level security is NOT active: the database has not been migrated (run "pnpm migration:run"). ' +
      'Access rules are enforced by the API only.';
    if (options.required) {
      throw new Error(message);
    }
    (options.warn ?? console.warn)(`WARNING: ${message}`);
    return false;
  }

  const pool = (dataSource.driver as unknown as { master: PgPool }).master;
  const originalConnect = pool.connect.bind(pool) as (callback: PgConnectCallback) => void;

  pool.connect = ((callback?: PgConnectCallback): unknown => {
    // captured now, in the requester's own async context
    const context = currentDbContext();
    const run = (done: PgConnectCallback): void => {
      originalConnect((error, client, release) => {
        if (error || !client || !release) {
          done(error ?? new Error('no database connection'));
          return;
        }
        applyContext(client, context).then(
          () => done(undefined, client, release),
          (applyError: unknown) => {
            // a connection that could not be put into the right state is never used
            release(applyError instanceof Error ? applyError : new Error(String(applyError)));
            done(applyError instanceof Error ? applyError : new Error(String(applyError)));
          },
        );
      });
    };
    if (typeof callback === 'function') {
      run(callback);
      return undefined;
    }
    return new Promise((resolve, reject) => {
      run((error, client, release) => (error ? reject(error) : resolve(Object.assign(client as object, { release }))));
    });
  }) as PgPool['connect'];

  installed.add(dataSource);
  return true;
}
