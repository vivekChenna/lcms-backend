import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { RecordingMailer } from '../../helpers/recording-mailer';
import { tokenFromEmail } from '../../helpers/password-links';

describe('POST /auth/set-password and the links that feed it', () => {
  let ds: DataSource;
  let adminId: string;
  let mailer: RecordingMailer;

  const build = () => buildTestApp(ds, { mailer, frontendUrl: 'https://lcms.example.com' });
  type App = ReturnType<typeof buildTestApp>;
  const adminAuth = (app: App) => ({
    authorization: `Bearer ${app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null })}`,
  });
  const invite = async (app: App, email: string) => {
    const res = await app.inject({ method: 'POST', url: '/users', headers: adminAuth(app), payload: { fullName: 'Invited Person', email } });
    expect(res.statusCode).toBe(201);
    return { id: res.json().id as string, token: tokenFromEmail(mailer, email) };
  };
  const setPassword = (app: App, token: string, newPassword: string) =>
    app.inject({ method: 'POST', url: '/auth/set-password', payload: { token, newPassword } });
  const login = (app: App, email: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

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

  it('lets the invited user choose a password, then sign in with it', async () => {
    const app = build();
    await app.ready();
    const { token } = await invite(app, 'new@algihaz.local');

    const res = await setPassword(app, token, 'MyOwn#Passw0rd');
    expect(res.statusCode).toBe(204);

    expect((await login(app, 'new@algihaz.local', 'MyOwn#Passw0rd')).statusCode).toBe(200);
    expect((await login(app, 'new@algihaz.local', 'wrong-password')).statusCode).toBe(401);

    const actions = (await ds.query(`SELECT action FROM audit_log`)).map((r: { action: string }) => r.action);
    expect(actions).toContain('user.password_set');
    await app.close();
  });

  it('works only once', async () => {
    const app = build();
    await app.ready();
    const { token } = await invite(app, 'once@algihaz.local');
    expect((await setPassword(app, token, 'First#Passw0rd')).statusCode).toBe(204);
    const again = await setPassword(app, token, 'Second#Passw0rd');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toMatch(/no longer valid/i);
    expect((await login(app, 'once@algihaz.local', 'First#Passw0rd')).statusCode).toBe(200);
    expect((await login(app, 'once@algihaz.local', 'Second#Passw0rd')).statusCode).toBe(401);
    await app.close();
  });

  it('rejects an expired link', async () => {
    const app = build();
    await app.ready();
    const { token } = await invite(app, 'late@algihaz.local');
    await ds.query(`UPDATE password_links SET "expiresAt" = now() - interval '1 minute'`);
    const res = await setPassword(app, token, 'Whatever#Passw0rd');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no longer valid/i);
    expect((await login(app, 'late@algihaz.local', 'Whatever#Passw0rd')).statusCode).toBe(401);
    await app.close();
  });

  it('gives links a 48 hour life', async () => {
    const app = build();
    await app.ready();
    await invite(app, 'life@algihaz.local');
    const [row] = await ds.query(`SELECT EXTRACT(EPOCH FROM ("expiresAt" - "createdAt")) / 3600 AS hours FROM password_links`);
    expect(Number(row.hours)).toBeCloseTo(48, 0);
    await app.close();
  });

  it('rejects a token that was never issued, without saying why', async () => {
    const app = build();
    await app.ready();
    const res = await setPassword(app, 'a'.repeat(64), 'Whatever#Passw0rd');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no longer valid/i);
    await app.close();
  });

  it('a newer link cancels the older one', async () => {
    const app = build();
    await app.ready();
    const { id, token: first } = await invite(app, 'two@algihaz.local');
    const resend = await app.inject({ method: 'POST', url: `/users/${id}/send-password-link`, headers: adminAuth(app) });
    expect(resend.statusCode).toBe(200);
    const second = tokenFromEmail(mailer, 'two@algihaz.local');
    expect(second).not.toBe(first);

    expect((await setPassword(app, first, 'Old#Passw0rd1')).statusCode).toBe(400);
    expect((await setPassword(app, second, 'New#Passw0rd1')).statusCode).toBe(204);
    await app.close();
  });

  it('enforces the 8 character minimum and keeps the link usable after a rejected password', async () => {
    const app = build();
    await app.ready();
    const { token } = await invite(app, 'short@algihaz.local');
    const short = await setPassword(app, token, 'short');
    expect(short.statusCode).toBe(400);
    expect((await setPassword(app, token, 'LongEnough#1')).statusCode).toBe(204);
    await app.close();
  });

  it('will not activate an account an admin has deactivated', async () => {
    const app = build();
    await app.ready();
    const { id, token } = await invite(app, 'off@algihaz.local');
    await app.inject({ method: 'PATCH', url: `/users/${id}/deactivate`, headers: adminAuth(app) });
    const res = await setPassword(app, token, 'Whatever#Passw0rd');
    expect(res.statusCode).toBe(400);
    expect((await login(app, 'off@algihaz.local', 'Whatever#Passw0rd')).statusCode).toBe(401);
    await app.close();
  });

  it('signs the user out everywhere when the password changes', async () => {
    const app = build();
    await app.ready();
    const { id, token } = await invite(app, 'sessions@algihaz.local');
    await setPassword(app, token, 'First#Passw0rd1');
    const session = await login(app, 'sessions@algihaz.local', 'First#Passw0rd1');
    const refreshToken = session.json().refreshToken as string;

    // a reset link, then a new password: the session minted under the old password must die
    await app.inject({ method: 'POST', url: `/users/${id}/send-password-link`, headers: adminAuth(app) });
    const resetToken = tokenFromEmail(mailer, 'sessions@algihaz.local');
    expect((await setPassword(app, resetToken, 'Second#Passw0rd2')).statusCode).toBe(204);

    const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refresh.statusCode).toBe(401);
    expect((await login(app, 'sessions@algihaz.local', 'Second#Passw0rd2')).statusCode).toBe(200);
    await app.close();
  });

  it('two people racing on one link: exactly one wins', async () => {
    const app = build();
    await app.ready();
    const { token } = await invite(app, 'race@algihaz.local');
    const results = await Promise.all([1, 2, 3, 4].map((n) => setPassword(app, token, `Racer#Passw0rd${n}`)));
    expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(3);
    await app.close();
  });
});
