import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from './helpers/test-data-source';
import { buildTestApp } from './helpers/build-test-app';
import { resetDatabase } from './helpers/reset-db';
import { seedUserWithRole } from './helpers/seed-user';
import { authHeader } from './helpers/auth-header';
import { AUDITED_ROUTES, EXEMPT_ROUTES, getRegisteredMutatingRoutes } from './helpers/audit-manifest';
import { logAuditEvent } from '../../src/modules/audit/audit.service';

describe('audit coverage guard', () => {
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

  it('every mutating route is classified as audited or exempt, and the manifest has no stale entries', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const registered = new Set(getRegisteredMutatingRoutes(app));
    const classified = new Set([...Object.keys(AUDITED_ROUTES), ...Object.keys(EXEMPT_ROUTES)]);

    expect([...registered].filter((route) => !classified.has(route)), 'registered but not classified').toEqual([]);
    expect([...classified].filter((route) => !registered.has(route)), 'classified but no longer registered').toEqual([]);
    await app.close();
  });

  it('no route is both audited and exempt, and every exemption has a reason', () => {
    const both = Object.keys(AUDITED_ROUTES).filter((route) => route in EXEMPT_ROUTES);
    expect(both).toEqual([]);
    for (const [route, reason] of Object.entries(EXEMPT_ROUTES)) {
      expect(reason.trim().length, `${route} needs a written reason`).toBeGreaterThan(10);
    }
    for (const [route, action] of Object.entries(AUDITED_ROUTES)) {
      expect(action.trim().length, `${route} needs its expected audit action`).toBeGreaterThan(0);
    }
  });

  it('a classified route that succeeds without writing an audit row fails loudly', async () => {
    const app = buildTestApp(ds, { extraAuditedRoutes: { 'POST /__test/no-audit': 'none', 'POST /__test/with-audit': 'test.event' } });
    const actorId = await seedUserWithRole(ds, 'admin');
    app.register(async (instance) => {
      instance.post('/__test/no-audit', async () => ({ ok: true }));
      instance.post('/__test/with-audit', async () => {
        await logAuditEvent(instance.dataSource, { actorId, action: 'test.event' });
        return { ok: true };
      });
    });
    await app.ready();
    const headers = authHeader(app, actorId, 'admin');

    const missing = await app.inject({ method: 'POST', url: '/__test/no-audit', headers, payload: {} });
    const present = await app.inject({ method: 'POST', url: '/__test/with-audit', headers, payload: {} });

    expect(missing.statusCode).toBe(500);
    expect(missing.json().error.code).toBe('AUDIT_COVERAGE_MISSING');
    expect(present.statusCode).toBe(200);
    await app.close();
  });

  it('a failed (non-2xx) request on an audited route is not flagged, and exempt routes are never checked', async () => {
    const app = buildTestApp(ds, { extraAuditedRoutes: { 'POST /__test/fails': 'none' } });
    app.register(async (instance) => {
      instance.post('/__test/fails', async (_request, reply) => reply.status(409).send({ error: { code: 'CONFLICT', message: 'nope' } }));
    });
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');

    const failed = await app.inject({ method: 'POST', url: '/__test/fails', headers: authHeader(app, adminId, 'admin'), payload: {} });
    const exempt = await app.inject({ method: 'POST', url: '/auth/logout', payload: {} });

    expect(failed.statusCode).toBe(409);
    expect(exempt.statusCode).toBe(204);
    await app.close();
  });
});
