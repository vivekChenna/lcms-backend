import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { RecordingMailer } from '../../helpers/recording-mailer';
import { tokenFromEmail } from '../../helpers/password-links';

describe('POST /auth/forgot-password and POST /users/:id/send-password-link', () => {
  let ds: DataSource;
  let adminId: string;
  let mailer: RecordingMailer;

  const build = () => buildTestApp(ds, { mailer, frontendUrl: 'https://lcms.example.com' });
  type App = ReturnType<typeof buildTestApp>;
  const adminAuth = (app: App) => ({
    authorization: `Bearer ${app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null })}`,
  });
  const forgot = (app: App, email: string) => app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });

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
    mailer = new RecordingMailer();
  });

  describe('forgot password (public)', () => {
    it('emails a reset link to a real, active account', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'real@algihaz.local' });
      const app = build();
      await app.ready();
      const res = await forgot(app, 'Real@Algihaz.local');
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
      expect(mailer.sent[0]!.to).toBe('real@algihaz.local');
      expect(mailer.sent[0]!.subject).toMatch(/reset your password/i);

      const token = tokenFromEmail(mailer, 'real@algihaz.local');
      const set = await app.inject({ method: 'POST', url: '/auth/set-password', payload: { token, newPassword: 'Brand#New1234' } });
      expect(set.statusCode).toBe(204);
      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'real@algihaz.local', password: 'Brand#New1234' } });
      expect(login.statusCode).toBe(200);
      await app.close();
    });

    it('answers the same way for an unknown address, a deactivated account and a real one', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'real@algihaz.local' });
      await seedUserWithRole(ds, 'requester', { email: 'off@algihaz.local', isActive: false });
      const app = build();
      await app.ready();
      const answers = [];
      for (const email of ['nobody@algihaz.local', 'off@algihaz.local', 'real@algihaz.local']) {
        const res = await forgot(app, email);
        answers.push({ status: res.statusCode, body: res.json() });
      }
      expect(answers[0]).toEqual(answers[1]);
      expect(answers[1]).toEqual(answers[2]);
      expect(answers[0]!.status).toBe(202);
      // only the real account got an email (wait for it, then give any stray send time to show up)
      await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mailer.sent.map((m) => m.to)).toEqual(['real@algihaz.local']);
      await app.close();
    });

    it('still answers 202 when the mail server is down', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'real@algihaz.local' });
      mailer.failAlways();
      const app = build();
      await app.ready();
      expect((await forgot(app, 'real@algihaz.local')).statusCode).toBe(202);
      await vi.waitFor(async () => {
        const rows = await ds.query(`SELECT 1 FROM audit_log WHERE action = 'user.password_link_requested'`);
        expect(rows).toHaveLength(1);
      });
      await app.close();
    });

    it('sends an invited user a link to finish setting up, not a reset', async () => {
      const app = build();
      await app.ready();
      await app.inject({ method: 'POST', url: '/users', headers: adminAuth(app), payload: { fullName: 'Inv', email: 'inv@algihaz.local' } });
      mailer.sent.length = 0;
      expect((await forgot(app, 'inv@algihaz.local')).statusCode).toBe(202);
      await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
      expect(mailer.sent[0]!.subject).toMatch(/set your password/i);
      await app.close();
    });

    it('rejects a malformed address', async () => {
      const app = build();
      await app.ready();
      expect((await forgot(app, 'not-an-email')).statusCode).toBe(400);
      await app.close();
    });

    it('is rate limited per address', async () => {
      const app = build();
      await app.ready();
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await forgot(app, 'spam@algihaz.local')).statusCode);
      expect(codes.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
      expect(codes.slice(5)).toEqual([429, 429]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await app.close();
    });

    it('records a request for a known account in the audit log', async () => {
      await seedUserWithRole(ds, 'requester', { email: 'real@algihaz.local' });
      const app = build();
      await app.ready();
      await forgot(app, 'real@algihaz.local');
      await vi.waitFor(async () => {
        const actions = (await ds.query(`SELECT action FROM audit_log`)).map((r: { action: string }) => r.action);
        expect(actions).toContain('user.password_link_requested');
      });
      await app.close();
    });
  });

  describe('admin sends a link', () => {
    it('emails a reset link to an active user and audits it', async () => {
      const userId = await seedUserWithRole(ds, 'viewer', { email: 'viewer@algihaz.local' });
      const app = build();
      await app.ready();
      const res = await app.inject({ method: 'POST', url: `/users/${userId}/send-password-link`, headers: adminAuth(app) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ emailSent: true });
      expect(mailer.sent[0]!.subject).toMatch(/reset your password/i);
      const actions = (await ds.query(`SELECT action FROM audit_log`)).map((r: { action: string }) => r.action);
      expect(actions).toContain('user.password_link_sent');
      await app.close();
    });

    it('fails loudly when the email cannot be sent, so the admin knows', async () => {
      const userId = await seedUserWithRole(ds, 'viewer');
      mailer.failAlways();
      const app = build();
      await app.ready();
      const res = await app.inject({ method: 'POST', url: `/users/${userId}/send-password-link`, headers: adminAuth(app) });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.message).toMatch(/could not be sent/i);
      await app.close();
    });

    it('refuses to send to a deactivated account', async () => {
      const userId = await seedUserWithRole(ds, 'viewer', { isActive: false });
      const app = build();
      await app.ready();
      const res = await app.inject({ method: 'POST', url: `/users/${userId}/send-password-link`, headers: adminAuth(app) });
      expect(res.statusCode).toBe(409);
      expect(mailer.sent).toHaveLength(0);
      await app.close();
    });

    it('404s for a user that does not exist', async () => {
      const app = build();
      await app.ready();
      const res = await app.inject({ method: 'POST', url: '/users/00000000-0000-4000-8000-000000000000/send-password-link', headers: adminAuth(app) });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('is for admins only', async () => {
      const userId = await seedUserWithRole(ds, 'viewer');
      const managerId = await seedUserWithRole(ds, 'legal_manager');
      const app = build();
      await app.ready();
      const token = app.signAccessToken({ id: managerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });
      const res = await app.inject({ method: 'POST', url: `/users/${userId}/send-password-link`, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('the old admin "set a password" route is gone', async () => {
      const userId = await seedUserWithRole(ds, 'viewer');
      const app = build();
      await app.ready();
      const res = await app.inject({ method: 'PATCH', url: `/users/${userId}/reset-password`, headers: adminAuth(app), payload: { newPassword: 'AdminChosen#1' } });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
