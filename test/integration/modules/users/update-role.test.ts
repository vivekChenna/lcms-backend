import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('PATCH /users/:id/role', () => {
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

  it("changes a user's role and logs the change", async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'legal_rep' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('legal_rep');

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.role_changed'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('holds up under two concurrent role-change requests without error or duplicate rows', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane2@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/users/${userId}/role`, headers: { authorization: `Bearer ${token}` }, payload: { role: 'legal_rep' } }),
      app.inject({ method: 'PATCH', url: `/users/${userId}/role`, headers: { authorization: `Bearer ${token}` }, payload: { role: 'viewer' } }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await ds.query(`SELECT "roleId" FROM user_roles WHERE "userId" = $1`, [userId]);
    expect(rows).toHaveLength(1);

    await app.close();
  });

  it("reflects a role change immediately on a stale token (code review finding — role was previously trusted from the JWT until it naturally expired)", async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Promotable', email: 'promotable@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;
    const staleToken = app.signAccessToken({ id: userId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const before = await app.inject({ method: 'GET', url: '/audit', headers: { authorization: `Bearer ${staleToken}` } });
    expect(before.statusCode).toBe(403);

    await app.inject({ method: 'PATCH', url: `/users/${userId}/role`, headers: { authorization: `Bearer ${token}` }, payload: { role: 'legal_manager' } });

    const after = await app.inject({ method: 'GET', url: '/audit', headers: { authorization: `Bearer ${staleToken}` } });
    expect(after.statusCode).toBe(200);

    await app.close();
  });

  it('rejects an unknown role name with a validation error', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane3@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'super_admin' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects role changes from a non-admin role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const managerToken = app.signAccessToken({ id: ADMIN_ID, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/00000000-0000-0000-0000-000000000000/role`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an admin changing their own role, even to another valid role (code review finding — prevents zero-admin lockout)', async () => {
    // A real RFC-4122 UUID (variant nibble 8/9/a/b) — needed here because,
    // unlike this file's other tests, this one uses ADMIN_ID as a validated
    // :id route param (patching the admin's own row), and Zod 4's
    // z.string().uuid() rejects the informal '111...1' pattern used as a
    // JWT-payload-only id elsewhere in this suite.
    const selfAdminId = '22222222-2222-4222-8222-222222222222';
    const app = buildTestApp(ds);
    await app.ready();

    await ds.query(
      `INSERT INTO users (id, "fullName", email, "passwordHash") VALUES ($1, 'Self Admin', 'self-role@algihaz.local', 'x')`,
      [selfAdminId],
    );
    const [adminRole] = await ds.query(`SELECT id FROM roles WHERE name = 'admin'`);
    await ds.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [selfAdminId, adminRole.id]);

    const token = app.signAccessToken({ id: selfAdminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${selfAdminId}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
