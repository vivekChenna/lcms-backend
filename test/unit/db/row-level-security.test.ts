import { describe, it, expect } from 'vitest';
import type { DataSource } from 'typeorm';
import { installRowLevelSecurity } from '../../../src/db/row-level-security';
import { runAsSystem, runAsUser, runInRequestContext, setRequestUser, currentDbContext } from '../../../src/db/request-context';

type FakeClient = { id: number; log: string[]; query: (sql: string, values?: unknown[]) => Promise<void>; __lcmsDbKey?: string };

/** A pool with `size` reusable connections that hands them out in order, queueing when all are busy. */
function fakePool(size: number, options: { failOn?: string } = {}) {
  const idle: FakeClient[] = Array.from({ length: size }, (_, id) => ({
    id,
    log: [],
    query: async function (this: FakeClient, sql: string, values?: unknown[]) {
      if (options.failOn && sql.includes(options.failOn)) throw new Error('boom');
      this.log.push(values ? `${sql} [${values.join(',')}]` : sql);
    },
  }));
  const waiting: ((client: FakeClient) => void)[] = [];
  const released: (Error | boolean | undefined)[] = [];
  const give = (client: FakeClient, callback: (e: Error | undefined, c?: FakeClient, r?: (e?: Error | boolean) => void) => void) =>
    callback(undefined, client, (error) => {
      released.push(error);
      const next = waiting.shift();
      if (next) next(client);
      else idle.push(client);
    });
  const pool = {
    connect(callback: (e: Error | undefined, c?: FakeClient, r?: (e?: Error | boolean) => void) => void) {
      const client = idle.shift();
      if (client) give(client, callback);
      else waiting.push((c) => give(c, callback));
    },
  };
  return { pool, released, clients: idle };
}

function dataSourceWith(pool: unknown, installed = true): DataSource {
  return {
    driver: { master: pool },
    query: async () => [{ installed }],
  } as unknown as DataSource;
}

const connect = (pool: ReturnType<typeof fakePool>['pool']) =>
  new Promise<{ client: FakeClient; release: (e?: Error | boolean) => void }>((resolve, reject) =>
    pool.connect((error, client, release) => (error ? reject(error) : resolve({ client: client!, release: release! }))),
  );

describe('request context', () => {
  it('is separate for each request and starts with nobody signed in', async () => {
    const seen: (string | null | undefined)[] = [];
    await new Promise<void>((resolve) => runInRequestContext(() => { seen.push(currentDbContext()?.userId); resolve(); }));
    expect(seen).toEqual([null]);
    expect(currentDbContext()).toBeUndefined();
  });

  it('lets authentication name the user, for that request only', async () => {
    const a = await runAsUser(null, async () => { setRequestUser('user-a'); return currentDbContext()?.userId; });
    const b = await runAsUser(null, async () => currentDbContext()?.userId);
    expect(a).toBe('user-a');
    expect(b).toBeNull();
  });

  it('runAsSystem steps outside the request', async () => {
    const inside = await runAsUser('user-a', async () => runAsSystem(async () => currentDbContext()));
    expect(inside).toBeUndefined();
  });
});

describe('installRowLevelSecurity', () => {
  it('puts the request\'s user on the connection and switches to the restricted role', async () => {
    const { pool } = fakePool(1);
    await installRowLevelSecurity(dataSourceWith(pool));
    const { client } = await runAsUser('user-a', () => connect(pool));
    expect(client.log).toEqual([`SELECT set_config('app.user_id', $1, false) [user-a]`, 'SET ROLE lcms_app']);
  });

  it('a request with nobody signed in is restricted too, with no user', async () => {
    const { pool } = fakePool(1);
    await installRowLevelSecurity(dataSourceWith(pool));
    const { client } = await runAsUser(null, () => connect(pool));
    expect(client.log).toEqual([`SELECT set_config('app.user_id', $1, false) []`, 'SET ROLE lcms_app']);
  });

  it('work outside any request gets the connection\'s own privileges', async () => {
    const { pool } = fakePool(1);
    await installRowLevelSecurity(dataSourceWith(pool));
    const { client } = await connect(pool);
    expect(client.log).toEqual(['RESET ROLE', `SELECT set_config('app.user_id', '', false)`]);
  });

  it('a reused connection is rewritten for the next user, and left alone when nothing changed', async () => {
    const { pool } = fakePool(1);
    await installRowLevelSecurity(dataSourceWith(pool));
    const first = await runAsUser('user-a', () => connect(pool));
    first.release();
    const sameAgain = await runAsUser('user-a', () => connect(pool));
    expect(sameAgain.client.log).toHaveLength(2); // nothing new for the same user
    sameAgain.release();
    const other = await runAsUser('user-b', () => connect(pool));
    expect(other.client.log.slice(2)).toEqual([`SELECT set_config('app.user_id', $1, false) [user-b]`, 'SET ROLE lcms_app']);
    other.release();
    const system = await connect(pool);
    expect(system.client.log.slice(-2)).toEqual(['RESET ROLE', `SELECT set_config('app.user_id', '', false)`]);
  });

  it('a request waiting for a connection gets its OWN user, not the user of whoever released it', async () => {
    const { pool } = fakePool(1);
    await installRowLevelSecurity(dataSourceWith(pool));
    const holder = await runAsUser('holder', () => connect(pool));
    // the pool is exhausted: this request queues, and is served from the holder's release
    const waiting = runAsUser('waiter', () => connect(pool));
    await Promise.resolve();
    runAsSystem(async () => holder.release());
    const { client } = await waiting;
    expect(client.log.slice(-2)).toEqual([`SELECT set_config('app.user_id', $1, false) [waiter]`, 'SET ROLE lcms_app']);
  });

  it('never hands out a connection it could not put into the right state', async () => {
    const { pool, released } = fakePool(1, { failOn: 'SET ROLE' });
    await installRowLevelSecurity(dataSourceWith(pool));
    await expect(runAsUser('user-a', () => connect(pool))).rejects.toThrow('boom');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error); // released with an error, which destroys the connection
  });

  it('refuses to run in production when the database has not been migrated', async () => {
    const { pool } = fakePool(1);
    await expect(installRowLevelSecurity(dataSourceWith(pool, false), { required: true })).rejects.toThrow(/not been migrated/);
  });

  it('only warns elsewhere, and leaves the pool untouched', async () => {
    const { pool } = fakePool(1);
    const original = pool.connect;
    const warnings: string[] = [];
    const active = await installRowLevelSecurity(dataSourceWith(pool, false), { required: false, warn: (m) => warnings.push(m) });
    expect(active).toBe(false);
    expect(warnings[0]).toMatch(/NOT active/);
    expect(pool.connect).toBe(original);
  });

  it('is installed once per data source', async () => {
    const { pool } = fakePool(1);
    const ds = dataSourceWith(pool);
    await installRowLevelSecurity(ds);
    const wrapped = pool.connect;
    await installRowLevelSecurity(ds);
    expect(pool.connect).toBe(wrapped);
  });
});
