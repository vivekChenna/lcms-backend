import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { RecordingMailer } from '../../helpers/recording-mailer';
import { tokenFromEmail } from '../../helpers/password-links';

describe('inviting a user (admin adds the person, the user chooses the password)', () => {
  let ds: DataSource;
  let adminId: string;
  let mailer: RecordingMailer;

  const build = () => buildTestApp(ds, { mailer, frontendUrl: 'https://lcms.example.com' });
  const adminToken = (app: ReturnType<typeof buildTestApp>) =>
    app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

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

  it('creates the user without a password, as invited, and emails a one-time link', async () => {
    const app = build();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${adminToken(app)}` },
      payload: { fullName: 'Jane Invitee', email: 'Jane@Algihaz.local' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ email: 'jane@algihaz.local', role: 'requester', isActive: true, isInvited: true, inviteEmailSent: true });
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|"password"/);

    const [row] = await ds.query(`SELECT "passwordHash" FROM users WHERE email = 'jane@algihaz.local'`);
    expect(row.passwordHash).toBeNull();

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('jane@algihaz.local');
    expect(mail.subject).toMatch(/set your password/i);
    expect(mail.text).toContain('https://lcms.example.com/set-password?token=');
    expect(mail.text).toMatch(/48 hours/);

    const actions = (await ds.query(`SELECT action FROM audit_log ORDER BY "createdAt"`)).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['user.created', 'user.password_link_sent']));
    await app.close();
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const app = build();
    await app.ready();
    await app.inject({ method: 'POST', url: '/users', headers: { authorization: `Bearer ${adminToken(app)}` }, payload: { fullName: 'J', email: 'j@algihaz.local' } });
    const token = tokenFromEmail(mailer, 'j@algihaz.local');
    const rows = await ds.query(`SELECT "tokenHash" FROM password_links`);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it('ignores a password sent by the client: admins never choose one', async () => {
    const app = build();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${adminToken(app)}` },
      payload: { fullName: 'Sneaky', email: 'sneaky@algihaz.local', password: 'Password123!' },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await ds.query(`SELECT "passwordHash" FROM users WHERE email = 'sneaky@algihaz.local'`);
    expect(row.passwordHash).toBeNull();
    await app.close();
  });

  it('an invited user cannot sign in until they set a password', async () => {
    const app = build();
    await app.ready();
    await app.inject({ method: 'POST', url: '/users', headers: { authorization: `Bearer ${adminToken(app)}` }, payload: { fullName: 'J', email: 'j@algihaz.local' } });
    for (const password of ['a', 'x', 'Password123!']) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'j@algihaz.local', password } });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it('still creates the user when the email cannot be sent, and says so', async () => {
    mailer.failAlways();
    const app = build();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${adminToken(app)}` },
      payload: { fullName: 'No Mail', email: 'nomail@algihaz.local' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ isInvited: true, inviteEmailSent: false });
    const rows = await ds.query(`SELECT 1 FROM users WHERE email = 'nomail@algihaz.local'`);
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('reports the email as not sent when no mailer is configured', async () => {
    const app = buildTestApp(ds, { frontendUrl: 'https://lcms.example.com' });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/users', headers: { authorization: `Bearer ${adminToken(app)}` }, payload: { fullName: 'A', email: 'a@algihaz.local' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().inviteEmailSent).toBe(false);
    await app.close();
  });

  it('only an admin can invite', async () => {
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const app = build();
    await app.ready();
    const token = app.signAccessToken({ id: managerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });
    const res = await app.inject({ method: 'POST', url: '/users', headers: { authorization: `Bearer ${token}` }, payload: { fullName: 'X', email: 'x@algihaz.local' } });
    expect(res.statusCode).toBe(403);
    expect(mailer.sent).toHaveLength(0);
    await app.close();
  });

  it('still rejects a duplicate email without sending a second email', async () => {
    const app = build();
    await app.ready();
    const send = () => app.inject({ method: 'POST', url: '/users', headers: { authorization: `Bearer ${adminToken(app)}` }, payload: { fullName: 'D', email: 'dup@algihaz.local' } });
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(409);
    expect(mailer.sent).toHaveLength(1);
    await app.close();
  });

  it('lists invited users as invited, and active users as not', async () => {
    const app = build();
    await app.ready();
    await app.inject({ method: 'POST', url: '/users', headers: { authorization: `Bearer ${adminToken(app)}` }, payload: { fullName: 'Inv', email: 'inv@algihaz.local' } });
    const res = await app.inject({ method: 'GET', url: '/users?pageSize=100', headers: { authorization: `Bearer ${adminToken(app)}` } });
    const items = res.json().items as { email: string; isInvited: boolean }[];
    expect(items.find((u) => u.email === 'inv@algihaz.local')?.isInvited).toBe(true);
    expect(items.filter((u) => u.email !== 'inv@algihaz.local').every((u) => u.isInvited === false)).toBe(true);
    await app.close();
  });
});
