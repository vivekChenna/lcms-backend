import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('GET /users, GET /users/:id', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('lists users with their role and a paginated envelope', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'jane@algihaz.local', password: 'Password123!' },
    });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].role).toBe('requester');

    await app.close();
  });

  it('allows legal_manager to list users (visibility without edit, PR-22)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const managerToken = app.signAccessToken({ id: ADMIN_ID, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${managerToken}` } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('returns 404 for an unknown user id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'GET',
      url: '/users/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects list access for a requester role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: ADMIN_ID, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);

    await app.close();
  });
});
