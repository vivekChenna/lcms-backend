import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedAdmin } from '../../../../src/db/seed-admin';

describe('POST /auth/refresh', () => {
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

  it('issues a new token pair for a valid refresh token', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(refreshToken);

    await app.close();
  });

  it('rejects reuse of an already-rotated refresh token (replay protection)', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an unknown refresh token', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'not-a-real-token' } });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
