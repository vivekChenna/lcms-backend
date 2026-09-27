import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('POST /users', () => {
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

  it('creates a user defaulted to the requester role (PR-31)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'Jane@Algihaz.local', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe('requester');
    expect(body.email).toBe('jane@algihaz.local');

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.created'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('rejects a duplicate email that only differs by case', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'jane@algihaz.local', password: 'Password123!' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Duplicate', email: 'Jane@Algihaz.local', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects creation by a non-admin role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: ADMIN_ID, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Someone', email: 'someone@algihaz.local', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a password shorter than 8 characters', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Someone', email: 'someone@algihaz.local', password: 'short' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a user created with a non-existent departmentId (code review finding)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        fullName: 'Someone',
        email: 'someone2@algihaz.local',
        password: 'Password123!',
        departmentId: '00000000-0000-0000-0000-000000000000',
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
