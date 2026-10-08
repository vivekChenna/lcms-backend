import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';

describe('POST /users', () => {
  let ds: DataSource;
  let adminId: string;

  function adminToken(app: ReturnType<typeof buildTestApp>) {
    return app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
  }

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
    await resetDatabase(ds);
    adminId = await seedUserWithRole(ds, 'admin');
  });

  it('creates a user defaulted to the requester role (PR-31)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'Jane@Algihaz.local' },
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
      payload: { fullName: 'Jane Requester', email: 'jane@algihaz.local' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Duplicate', email: 'Jane@Algihaz.local' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects creation by a non-admin role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const legalManagerId = await seedUserWithRole(ds, 'legal_manager');
    const token = app.signAccessToken({ id: legalManagerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Someone', email: 'someone@algihaz.local' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a malformed email address', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Someone', email: 'not-an-email' },
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
        departmentId: '00000000-0000-0000-0000-000000000000',
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rolls back the user row if the role assignment fails, rather than leaving a roleless user behind (code review finding)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    // Force the second write inside createUser's transaction (assigning the
    // 'requester' role) to fail, by temporarily renaming that role so the
    // findOneOrFail lookup throws. Proves the transaction actually rolls
    // back the first write (the user row) rather than leaving a user with
    // no role — previously unrecoverable via the API (permanent 500s on
    // login, GET /users/:id, and the whole GET /users page).
    await ds.query(`UPDATE roles SET name = 'requester_renamed' WHERE name = 'requester'`);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${token}` },
        payload: { fullName: 'Should Not Exist', email: 'rollback-check@algihaz.local' },
      });

      expect(res.statusCode).toBe(500);

      const rows = await ds.query(`SELECT id FROM users WHERE email = 'rollback-check@algihaz.local'`);
      expect(rows).toHaveLength(0);
    } finally {
      await ds.query(`UPDATE roles SET name = 'requester' WHERE name = 'requester_renamed'`);
    }

    await app.close();
  });
});
