import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedAdmin } from '../../../../src/db/seed-admin';
import { User } from '../../../../src/modules/users/entities/user.entity';

describe('Drona sign-in', () => {
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
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
  });
  // the developer's .env may select drona, so every test states its own strategy
  const originalStrategy = process.env.AUTH_STRATEGY;
  beforeEach(() => {
    process.env.AUTH_STRATEGY = 'local';
  });
  afterEach(() => {
    if (originalStrategy === undefined) delete process.env.AUTH_STRATEGY;
    else process.env.AUTH_STRATEGY = originalStrategy;
  });

  const drona = (app: ReturnType<typeof buildTestApp>, email: string) =>
    app.inject({ method: 'POST', url: '/auth/drona', payload: { email } });

  it('reports password sign-in by default', async () => {
    const app = buildTestApp(ds);
    const res = await app.inject({ method: 'GET', url: '/auth/config' });
    expect(res.json()).toEqual({ mode: 'local', localLoginAllowed: true });
  });

  it('refuses the Drona endpoint unless the strategy is drona', async () => {
    const res = await drona(buildTestApp(ds), 'admin@lcms.local');
    expect(res.statusCode).toBe(409);
  });

  describe('with AUTH_STRATEGY=drona', () => {
    beforeEach(() => {
      process.env.AUTH_STRATEGY = 'drona';
    });

    it('reports drona and no password sign-in', async () => {
      const res = await buildTestApp(ds).inject({ method: 'GET', url: '/auth/config' });
      expect(res.json()).toEqual({ mode: 'drona', localLoginAllowed: false });
    });

    it('signs in the active user with that email, ignoring case, and sets the session cookies', async () => {
      const res = await drona(buildTestApp(ds), 'Admin@LCMS.local');
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe('admin@lcms.local');
      expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
    });

    it('lets an admin seeded without a password sign in through Drona', async () => {
      await seedAdmin(ds, { email: 'ext-vivek.chenna@algihaz.com' });
      const res = await drona(buildTestApp(ds), 'ext-vivek.chenna@algihaz.com');
      expect(res.statusCode).toBe(200);
      expect(res.json().user.role).toBe('admin');
    });

    it('does not create an account for an unknown email', async () => {
      const res = await drona(buildTestApp(ds), 'stranger@lcms.local');
      expect(res.statusCode).toBe(401);
      expect(await ds.getRepository(User).count()).toBe(1);
    });

    it('refuses a deactivated user', async () => {
      await ds.getRepository(User).update({ email: 'admin@lcms.local' }, { isActive: false });
      const res = await drona(buildTestApp(ds), 'admin@lcms.local');
      expect(res.statusCode).toBe(401);
    });

    it('turns password sign-in off', async () => {
      const res = await buildTestApp(ds).inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@lcms.local', password: 'Correct123!' },
      });
      expect(res.statusCode).toBe(503);
    });
  });
});
