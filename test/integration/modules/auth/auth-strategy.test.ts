import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { RecordingMailer } from '../../helpers/recording-mailer';

describe('AUTH_STRATEGY (GET /auth/config, POST /auth/drona)', () => {
  let ds: DataSource;
  const originalStrategy = process.env.AUTH_STRATEGY;

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

  afterEach(() => {
    // loadEnv() is read once per buildApp() call, from process.env at that moment --
    // never leave a later test's app accidentally built under this test's override.
    if (originalStrategy === undefined) delete process.env.AUTH_STRATEGY;
    else process.env.AUTH_STRATEGY = originalStrategy;
  });

  describe('GET /auth/config', () => {
    it('defaults to local, with local login allowed', async () => {
      delete process.env.AUTH_STRATEGY;
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/auth/config' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mode: 'local', localLoginAllowed: true });
      await app.close();
    });

    it('reports drona mode with local login disallowed', async () => {
      process.env.AUTH_STRATEGY = 'drona';
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/auth/config' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mode: 'drona', localLoginAllowed: false });
      await app.close();
    });
  });

  describe('POST /auth/drona', () => {
    it('signs in an existing active user by email alone, no password', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'drona-user@algihaz.local' });
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/drona',
        payload: { email: 'drona-user@algihaz.local' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accessToken).toBeTypeOf('string');
      expect(body.refreshToken).toBeTypeOf('string');
      expect(body.user.email).toBe('drona-user@algihaz.local');
      expect(body.user.role).toBe('requester');
      await app.close();
    });

    it('is case-insensitive on email, matching /auth/login', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'drona-case@algihaz.local' });
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/drona',
        payload: { email: 'DRONA-CASE@Algihaz.local' },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects an email with no LCMS account', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/drona',
        payload: { email: 'nobody@algihaz.local' },
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('rejects a deactivated user', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'drona-inactive@algihaz.local' });
      await ds.query(`UPDATE users SET "isActive" = false WHERE email = 'drona-inactive@algihaz.local'`);
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/drona',
        payload: { email: 'drona-inactive@algihaz.local' },
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('rate-limits repeated attempts against the same email (same user-enumeration risk as /auth/login)', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const attempt = () => app.inject({
        method: 'POST',
        url: '/auth/drona',
        payload: { email: 'nobody@algihaz.local' },
      });

      const results = [];
      for (let i = 0; i < 6; i += 1) {
        results.push(await attempt());
      }

      expect(results.slice(0, 5).every((r) => r.statusCode === 401)).toBe(true);
      expect(results[5].statusCode).toBe(429);
      await app.close();
    });
  });

  describe('POST /auth/login while AUTH_STRATEGY=drona', () => {
    it('refuses even with correct credentials -- the UI toggle is not the real boundary', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'local-fallback@algihaz.local' });
      process.env.AUTH_STRATEGY = 'drona';
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'local-fallback@algihaz.local', password: 'Password123!' },
      });

      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('password links while AUTH_STRATEGY=drona', () => {
    let adminId: string;
    let mailer: RecordingMailer;

    beforeEach(async () => {
      adminId = await seedUserWithRole(ds, 'admin');
      mailer = new RecordingMailer();
      process.env.AUTH_STRATEGY = 'drona';
    });

    const adminToken = (app: ReturnType<typeof buildTestApp>) =>
      app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    it('creating a user sends no invite email -- the account already signs in via /auth/drona with no password', async () => {
      const app = buildTestApp(ds, { mailer, frontendUrl: 'https://lcms.example.com' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken(app)}` },
        payload: { fullName: 'Drona User', email: 'drona-new@algihaz.local' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ isInvited: true, inviteEmailSent: false });
      expect(mailer.sent).toHaveLength(0);

      // the account is immediately usable -- no password, no link needed
      const signIn = await app.inject({
        method: 'POST',
        url: '/auth/drona',
        payload: { email: 'drona-new@algihaz.local' },
      });
      expect(signIn.statusCode).toBe(200);
      await app.close();
    });

    it('admin "resend password link" gives a clear, specific error instead of a misleading delivery failure', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'drona-existing@algihaz.local' });
      const app = buildTestApp(ds, { mailer, frontendUrl: 'https://lcms.example.com' });
      await app.ready();
      const [{ id: userId }] = await ds.query(`SELECT id FROM users WHERE email = 'drona-existing@algihaz.local'`);

      const res = await app.inject({
        method: 'POST',
        url: `/users/${userId}/send-password-link`,
        headers: { authorization: `Bearer ${adminToken(app)}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/not used while sign-in is through Drona/i);
      expect(mailer.sent).toHaveLength(0);
      await app.close();
    });
  });
});
