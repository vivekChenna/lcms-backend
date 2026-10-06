import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { authHeader } from '../../helpers/auth-header';

describe('audit names and date filter', () => {
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

  it('rows carry the actor name and role and the case reference', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const adminId = await seedUserWithRole(ds, 'admin', { fullName: 'Amal Admin' });
    await logAuditEvent(ds, { actorId: adminId, caseId: caseRow.id, action: 'case.updated' });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created' });

    const res = await app.inject({ method: 'GET', url: '/audit', headers: authHeader(app, adminId, 'admin') });

    const withCase = res.json().items.find((item: { action: string }) => item.action === 'case.updated');
    const withoutCase = res.json().items.find((item: { action: string }) => item.action === 'user.created');
    expect(withCase).toMatchObject({ actorName: 'Amal Admin', actorRole: 'admin', caseReference: caseRow.referenceNumber });
    expect(withoutCase).toMatchObject({ actorName: 'Amal Admin', caseReference: null });
    await app.close();
  });

  it('createdFrom and createdTo narrow the list and the export, inclusively, and combine with other filters', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    for (const [action, when] of [['old.event', '2026-01-10T00:00:00Z'], ['mid.event', '2026-02-10T00:00:00Z'], ['new.event', '2026-03-10T00:00:00Z']]) {
      await logAuditEvent(ds, { actorId: adminId, action });
      await ds.query(`UPDATE audit_log SET "createdAt" = $1 WHERE action = $2`, [when, action]);
    }
    const headers = authHeader(app, adminId, 'admin');

    const window = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-02-10T00:00:00Z&createdTo=2026-03-10T00:00:00Z', headers });
    const onlyFrom = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-03-01T00:00:00Z', headers });
    const combined = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-01-01T00:00:00Z&action=old.event', headers });
    const exported = await app.inject({ method: 'GET', url: '/audit/export?createdTo=2026-01-31T00:00:00Z', headers });

    expect(window.json().items.map((i: { action: string }) => i.action).sort()).toEqual(['mid.event', 'new.event']);
    expect(onlyFrom.json().items.map((i: { action: string }) => i.action)).toEqual(['new.event']);
    expect(combined.json().total).toBe(1);
    expect(exported.body).toContain('old.event');
    expect(exported.body).not.toContain('mid.event');
    await app.close();
  });

  it('rejects createdFrom after createdTo and unparsable dates with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    const headers = authHeader(app, adminId, 'admin');

    const reversed = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-03-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z', headers });
    const garbage = await app.inject({ method: 'GET', url: '/audit?createdFrom=whenever', headers });
    const exportReversed = await app.inject({ method: 'GET', url: '/audit/export?createdFrom=2026-03-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z', headers });

    expect(reversed.statusCode).toBe(400);
    expect(garbage.statusCode).toBe(400);
    expect(exportReversed.statusCode).toBe(400);
    await app.close();
  });

  it('the CSV export includes the name and reference columns', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const adminId = await seedUserWithRole(ds, 'admin', { fullName: 'Amal Admin' });
    await logAuditEvent(ds, { actorId: adminId, caseId: caseRow.id, action: 'case.updated' });

    const res = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, adminId, 'admin') });

    const lines = res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('actorName');
    expect(lines[0]).toContain('actorRole');
    expect(lines[0]).toContain('caseReference');
    expect(res.body).toContain('Amal Admin');
    expect(res.body).toContain(caseRow.referenceNumber);
    await app.close();
  });
});
