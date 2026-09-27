import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedAdmin } from '../../../../src/db/seed-admin';

describe('POST /auth/logout', () => {
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

  it('revokes the refresh token so it can no longer be used to refresh', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    const logoutRes = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });
    expect(logoutRes.statusCode).toBe(204);

    const refreshRes = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refreshRes.statusCode).toBe(401);

    await app.close();
  });

  it('returns 204 even for an unknown token (idempotent, no information leak)', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: 'unknown-token' } });
    expect(res.statusCode).toBe(204);

    await app.close();
  });
});
