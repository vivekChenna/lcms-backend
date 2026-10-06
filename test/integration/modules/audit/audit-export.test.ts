// test/integration/modules/audit/audit-export.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { authHeader } from '../../helpers/auth-header';

describe('GET /audit/export', () => {
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

  const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').filter((line) => line.length > 0);

  it('exports audit rows as CSV for an admin and a legal manager', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created', afterValue: { id: 'x', note: 'a,b' } });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.updated' });

    const asAdmin = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, adminId, 'admin') });
    const asManager = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.headers['content-disposition']).toMatch(/^attachment; filename="audit-\d{8}\.csv"$/);
    expect(asAdmin.headers['x-export-total']).toBe('2');
    expect(lines(asAdmin.body)[0]).toContain('action');
    expect(lines(asAdmin.body)).toHaveLength(3);
    expect(asAdmin.body).toContain('user.created');
    expect(asManager.statusCode).toBe(200);
    await app.close();
  });

  it('applies the same filters as GET /audit', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created' });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.updated' });

    const res = await app.inject({ method: 'GET', url: '/audit/export?action=user.updated', headers: authHeader(app, adminId, 'admin') });

    expect(lines(res.body)).toHaveLength(2);
    expect(res.body).toContain('user.updated');
    expect(res.body).not.toContain('user.created');
    await app.close();
  });

  it('forbids every other role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    for (const role of ['legal_rep', 'requester', 'viewer'] as const) {
      const userId = await seedUserWithRole(ds, role);
      const res = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, userId, role) });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it('caps the rows and reports the truncation', async () => {
    const app = buildTestApp(ds, { exportRowCap: 2 });
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    for (let i = 0; i < 3; i += 1) {
      await logAuditEvent(ds, { actorId: adminId, action: `test.event.${i}` });
    }

    const res = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, adminId, 'admin') });

    expect(lines(res.body)).toHaveLength(3);
    expect(res.headers['x-export-total']).toBe('3');
    expect(res.headers['x-export-truncated']).toBe('true');
    await app.close();
  });
});
