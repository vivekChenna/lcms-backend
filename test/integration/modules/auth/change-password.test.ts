import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedAdmin } from '../../../../src/db/seed-admin';

describe('POST /auth/change-password (code review finding — no self-service path, and no way to recover a lost password)', () => {
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

  beforeEach(async () => {
    await ds.query('DELETE FROM refresh_tokens');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it("changes the caller's own password and revokes their existing refresh tokens", async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'OldPassword123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@lcms.local', password: 'OldPassword123!' } });
    const { accessToken, refreshToken } = login.json();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: 'OldPassword123!', newPassword: 'NewPassword123!' },
    });
    expect(res.statusCode).toBe(204);

    const oldLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@lcms.local', password: 'OldPassword123!' } });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@lcms.local', password: 'NewPassword123!' } });
    expect(newLogin.statusCode).toBe(200);

    const refreshAttempt = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refreshAttempt.statusCode).toBe(401);

    await app.close();
  });

  it('rejects the wrong current password', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'OldPassword123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@lcms.local', password: 'OldPassword123!' } });
    const { accessToken } = login.json();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: 'wrong-password', newPassword: 'NewPassword123!' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: { currentPassword: 'whatever', newPassword: 'NewPassword123!' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
