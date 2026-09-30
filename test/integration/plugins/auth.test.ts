import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';
import { seedUserWithRole } from '../helpers/seed-user';

describe('authenticate preHandler', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('rejects a request with no Authorization header', async () => {
    const app = buildTestApp(ds);
    app.get('/protected', { preHandler: (request, reply) => app.authenticate(request, reply) }, async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('accepts a request with a valid access token for a real user and populates request.user from the current DB row', async () => {
    const app = buildTestApp(ds);
    app.get(
      '/protected',
      { preHandler: (request, reply) => app.authenticate(request, reply) },
      async (request) => ({ userId: request.user.id, role: request.user.role }),
    );
    await app.ready();

    const userId = await seedUserWithRole(ds, 'admin');
    const token = app.signAccessToken({ id: userId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId, role: 'admin' });

    await app.close();
  });

  it('rejects a well-formed, validly-signed token whose id has no matching user row (code review finding — a stale row gives up no access, it used to be trusted)', async () => {
    const app = buildTestApp(ds);
    app.get('/protected', { preHandler: (request, reply) => app.authenticate(request, reply) }, async () => ({ ok: true }));
    await app.ready();

    const noSuchUserId = '99999999-9999-4999-8999-999999999999';
    const token = app.signAccessToken({ id: noSuchUserId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
