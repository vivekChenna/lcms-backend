import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';

describe('PATCH /users/:id, PATCH /users/:id/activate, PATCH /users/:id/reset-password (code review finding — no way to reactivate, edit, or reset a password)', () => {
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
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM refresh_tokens');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
    adminId = await seedUserWithRole(ds, 'admin');
  });

  it("updates a user's profile fields and logs the change", async () => {
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
      url: `/users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Updated', designation: 'Senior Counsel' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fullName).toBe('Jane Updated');
    expect(res.json().designation).toBe('Senior Counsel');

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.updated'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('rejects an update referencing an unknown departmentId', async () => {
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

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { departmentId: '00000000-0000-0000-0000-000000000000' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('reactivates a deactivated user', async () => {
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

    await app.inject({ method: 'PATCH', url: `/users/${userId}/deactivate`, headers: { authorization: `Bearer ${token}` } });

    const res = await app.inject({ method: 'PATCH', url: `/users/${userId}/activate`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(true);

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.activated'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('does not write a duplicate audit entry when activating an already-active user', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane4@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const res = await app.inject({ method: 'PATCH', url: `/users/${userId}/activate`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.activated'`);
    expect(auditRows).toHaveLength(0);

    await app.close();
  });

  it("admin resets a user's password, which revokes their existing refresh tokens", async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane5@algihaz.local', password: 'OldPassword123!' },
    });
    const userId = created.json().id;

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'jane5@algihaz.local', password: 'OldPassword123!' } });
    const { refreshToken } = login.json();

    const reset = await app.inject({
      method: 'PATCH',
      url: `/users/${userId}/reset-password`,
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: 'NewPassword123!' },
    });
    expect(reset.statusCode).toBe(204);

    const oldLoginAttempt = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'jane5@algihaz.local', password: 'OldPassword123!' } });
    expect(oldLoginAttempt.statusCode).toBe(401);

    const newLoginAttempt = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'jane5@algihaz.local', password: 'NewPassword123!' } });
    expect(newLoginAttempt.statusCode).toBe(200);

    const refreshAttempt = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refreshAttempt.statusCode).toBe(401);

    await app.close();
  });

  it('rejects non-admin access to activate/update/reset-password', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const requesterId = await seedUserWithRole(ds, 'requester');
    const requesterToken = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const activate = await app.inject({ method: 'PATCH', url: `/users/${requesterId}/activate`, headers: { authorization: `Bearer ${requesterToken}` } });
    expect(activate.statusCode).toBe(403);

    const update = await app.inject({ method: 'PATCH', url: `/users/${requesterId}`, headers: { authorization: `Bearer ${requesterToken}` }, payload: { fullName: 'X' } });
    expect(update.statusCode).toBe(403);

    const reset = await app.inject({ method: 'PATCH', url: `/users/${requesterId}/reset-password`, headers: { authorization: `Bearer ${requesterToken}` }, payload: { newPassword: 'Whatever123!' } });
    expect(reset.statusCode).toBe(403);

    await app.close();
  });
});
