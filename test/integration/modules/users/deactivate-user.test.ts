import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

// A real RFC-4122 UUID (variant nibble 8/9/a/b) — unlike the informal
// '111...1' pattern used elsewhere, this one is also used as a validated
// :id route param in this file, and Zod 4's z.string().uuid() rejects
// non-compliant variant nibbles.
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>, id = ADMIN_ID) {
  return app.signAccessToken({ id, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('PATCH /users/:id/deactivate', () => {
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

  it('deactivates another user and logs the change', async () => {
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
      url: `/users/${userId}/deactivate`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.deactivated'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('rejects an admin attempting to deactivate their own account (VC-18/PR-25)', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    await ds.query(
      `INSERT INTO users (id, "fullName", email, "passwordHash") VALUES ($1, 'Self Admin', 'self@algihaz.local', 'x')`,
      [ADMIN_ID],
    );
    const [adminRole] = await ds.query(`SELECT id FROM roles WHERE name = 'admin'`);
    await ds.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [ADMIN_ID, adminRole.id]);
    const token = adminToken(app);

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${ADMIN_ID}/deactivate`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('cuts off access immediately on deactivation, even with an unexpired access token (code review finding — a stateless JWT was previously trusted until natural expiry)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Stale Token User', email: 'stale@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;
    const staleToken = app.signAccessToken({ id: userId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const before = await app.inject({ method: 'GET', url: '/departments', headers: { authorization: `Bearer ${staleToken}` } });
    expect(before.statusCode).toBe(200);

    await app.inject({ method: 'PATCH', url: `/users/${userId}/deactivate`, headers: { authorization: `Bearer ${token}` } });

    const after = await app.inject({ method: 'GET', url: '/departments', headers: { authorization: `Bearer ${staleToken}` } });
    expect(after.statusCode).toBe(401);

    await app.close();
  });

  it('returns 404 for an unknown user id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'PATCH',
      url: '/users/00000000-0000-0000-0000-000000000000/deactivate',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
