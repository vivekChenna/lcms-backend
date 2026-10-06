import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';
import { resetDatabase } from '../helpers/reset-db';
import { seedUserWithRole } from '../helpers/seed-user';
import { authHeader } from '../helpers/auth-header';

const ALLOWED = 'http://localhost:5173';
const FOREIGN = 'https://evil.example';

describe('CORS and CSRF protection', () => {
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

  describe('CORS', () => {
    it('answers a preflight from an allowed origin with credentials allowed', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/cases',
        headers: { origin: ALLOWED, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type' },
      });

      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toMatch(/PATCH/);
      await app.close();
    });

    it('does not grant a foreign origin anything', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: FOREIGN } });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });

    it('exposes the CSV export headers to the allowed origin', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const viewerId = await seedUserWithRole(ds, 'viewer');

      const res = await app.inject({ method: 'GET', url: '/cases/export', headers: { ...authHeader(app, viewerId, 'viewer'), origin: ALLOWED } });

      const exposed = String(res.headers['access-control-expose-headers']).toLowerCase();
      expect(exposed).toContain('content-disposition');
      expect(exposed).toContain('x-export-total');
      expect(exposed).toContain('x-export-truncated');
      await app.close();
    });

    it('is off when no origins are configured', async () => {
      const app = buildTestApp(ds, { security: { corsOrigins: [] } });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: ALLOWED } });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });
  });

  describe('CSRF rule for cookie-authenticated mutations', () => {
    const cookie = { cookie: 'lcms_access=anything' };

    it('blocks a mutating request carrying our cookie with no Origin header', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: cookie, payload: {} });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_BLOCKED');
      await app.close();
    });

    it('blocks a mutating request carrying our cookie from a foreign origin', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { ...cookie, origin: FOREIGN }, payload: {} });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_BLOCKED');
      await app.close();
    });

    it('also guards the refresh cookie', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: 'lcms_refresh=anything', origin: FOREIGN }, payload: {} });

      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('lets a cookie request from an allowed origin through to the route', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { ...cookie, origin: ALLOWED }, payload: {} });

      expect(res.statusCode).not.toBe(403);
      await app.close();
    });

    it('never blocks safe methods', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health', headers: { ...cookie, origin: FOREIGN } });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('never blocks a request that carries an Authorization header', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const userId = await seedUserWithRole(ds, 'requester');

      const res = await app.inject({
        method: 'PATCH',
        url: '/notifications/read-all',
        headers: { ...authHeader(app, userId, 'requester'), ...cookie, origin: FOREIGN },
      });

      expect(res.statusCode).not.toBe(403);
      await app.close();
    });

    it('never blocks a mutating request that carries none of our cookies', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: FOREIGN }, payload: { email: 'nobody@algihaz.local', password: 'x' } });

      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});
