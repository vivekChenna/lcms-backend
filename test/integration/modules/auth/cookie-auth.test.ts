// test/integration/modules/auth/cookie-auth.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';

const ORIGIN = 'http://localhost:5173';

function cookiesFrom(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const jar: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(';');
    const [name, ...value] = pair.split('=');
    jar[name.trim()] = value.join('=');
  }
  return jar;
}

function setCookieLine(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.find((line) => line.startsWith(`${name}=`)) ?? '';
}

describe('cookie authentication', () => {
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

  async function loginAs(app: ReturnType<typeof buildTestApp>, email: string) {
    return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Password123!' } });
  }

  it('login sets both HttpOnly cookies with the configured attributes and still returns the tokens', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester', { email: 'cookie@algihaz.local' });

    const res = await loginAs(app, 'cookie@algihaz.local');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user.id).toBe(userId);
    const access = setCookieLine(res, 'lcms_access');
    const refresh = setCookieLine(res, 'lcms_refresh');
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Path=\//);
    expect(access).toMatch(/Max-Age=900/);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).not.toMatch(/Secure/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/auth/);
    expect(refresh).toMatch(/Max-Age=2592000/);
    await app.close();
  });

  it('marks cookies Secure and with the domain when configured', async () => {
    const app = buildTestApp(ds, { security: { cookie: { secure: true, sameSite: 'none', domain: '.algihaz.example', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2_592_000 } } });
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'secure@algihaz.local' });

    const res = await loginAs(app, 'secure@algihaz.local');

    const access = setCookieLine(res, 'lcms_access');
    expect(access).toMatch(/Secure/i);
    expect(access).toMatch(/SameSite=None/i);
    expect(access).toMatch(/Domain=\.algihaz\.example/i);
    await app.close();
  });

  it('authenticates a request from the access cookie alone', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'jar@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'jar@algihaz.local'));

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `lcms_access=${jar.lcms_access}` } });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('gives the Authorization header precedence and never falls back to the cookie when the header is malformed', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'a@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'a@algihaz.local'));

    const badHeader = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer not-a-token', cookie: `lcms_access=${jar.lcms_access}` } });
    const wrongScheme = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Basic abc', cookie: `lcms_access=${jar.lcms_access}` } });

    expect(badHeader.statusCode).toBe(401);
    expect(wrongScheme.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a missing or garbage access cookie with 401', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const none = await app.inject({ method: 'GET', url: '/auth/me' });
    const garbage = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: 'lcms_access=garbage' } });

    expect(none.statusCode).toBe(401);
    expect(garbage.statusCode).toBe(401);
    await app.close();
  });

  it('refresh works from the cookie, rotates the token and sets new cookies; replaying the old one fails', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'r@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'r@algihaz.local'));

    const first = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: `lcms_refresh=${jar.lcms_refresh}`, origin: ORIGIN }, payload: {} });
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: `lcms_refresh=${jar.lcms_refresh}`, origin: ORIGIN }, payload: {} });

    expect(first.statusCode).toBe(200);
    const next = cookiesFrom(first);
    expect(next.lcms_refresh).toBeTruthy();
    expect(next.lcms_refresh).not.toBe(jar.lcms_refresh);
    expect(next.lcms_access).toBeTruthy();
    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it('refresh still works with the token in the body (API clients) and answers 401 with no token at all', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'b@algihaz.local' });
    const login = (await loginAs(app, 'b@algihaz.local')).json();

    const viaBody = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: login.refreshToken } });
    const nothing = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} });

    expect(viaBody.statusCode).toBe(200);
    expect(nothing.statusCode).toBe(401);
    await app.close();
  });

  it('logout revokes the refresh token from the cookie and clears both cookies; it is idempotent without a token', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'l@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'l@algihaz.local'));

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `lcms_refresh=${jar.lcms_refresh}`, origin: ORIGIN }, payload: {} });
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: jar.lcms_refresh } });
    const again = await app.inject({ method: 'POST', url: '/auth/logout', payload: {} });

    expect(out.statusCode).toBe(204);
    expect(setCookieLine(out, 'lcms_access')).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
    expect(setCookieLine(out, 'lcms_refresh')).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
    expect(replay.statusCode).toBe(401);
    expect(again.statusCode).toBe(204);
    await app.close();
  });

  it('a deactivated user is cut off immediately even with a valid cookie', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester', { email: 'd@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'd@algihaz.local'));
    await ds.query(`UPDATE users SET "isActive" = false WHERE id = $1`, [userId]);

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `lcms_access=${jar.lcms_access}` } });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // The CSRF plugin skips its Origin check whenever any Authorization header is
  // present, so a request carrying one must never be authenticated by the cookie.
  it('never authenticates via the cookie when any Authorization header is present, even on a foreign-origin mutation', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'csrf@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'csrf@algihaz.local'));
    const body = { currentPassword: 'Password123!', newPassword: 'NewPassword456!' };

    const basic = await app.inject({ method: 'POST', url: '/auth/change-password', headers: { authorization: 'Basic abc', cookie: `lcms_access=${jar.lcms_access}`, origin: 'http://evil.example' }, payload: body });
    const blank = await app.inject({ method: 'POST', url: '/auth/change-password', headers: { authorization: ' ', cookie: `lcms_access=${jar.lcms_access}`, origin: 'http://evil.example' }, payload: body });
    const control = await app.inject({ method: 'POST', url: '/auth/change-password', headers: { cookie: `lcms_access=${jar.lcms_access}`, origin: ORIGIN }, payload: body });

    expect(basic.statusCode).toBe(401);
    expect(blank.statusCode).toBe(401);
    expect(control.statusCode).toBe(204);
    await app.close();
  });
});
