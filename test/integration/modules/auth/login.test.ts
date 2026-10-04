import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedAdmin } from '../../../../src/db/seed-admin';

describe('POST /auth/login', () => {
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
    await resetDatabase(ds);
  });

  it('returns access + refresh tokens for correct credentials', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user.role).toBe('admin');

    await app.close();
  });

  it('rejects an incorrect password', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'wrong-password' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects login for a deactivated user even with the correct password', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    await ds.query(`UPDATE users SET "isActive" = false WHERE email = 'admin@lcms.local'`);
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a malformed email with a validation error', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email', password: 'whatever' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('rate-limits repeated attempts against the same email (code review finding — no brute-force protection existed)', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const attempt = () => app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'wrong-password' },
    });

    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await attempt());
    }

    expect(results.slice(0, 5).every((r) => r.statusCode === 401)).toBe(true);
    expect(results[5].statusCode).toBe(429);

    await app.close();
  });

  it('does not rate-limit a different email from the same caller', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    await seedAdmin(ds, { email: 'other@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@lcms.local', password: 'wrong-password' } });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'other@lcms.local', password: 'Correct123!' },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
