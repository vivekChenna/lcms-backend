// test/integration/modules/cases/cases-export.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('GET /cases/export', () => {
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

  it('returns a CSV download with BOM, header, one row per visible case and the export headers', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, referenceNumber: 'EXP-0001', title: 'First' });
    await seedCase(ds, { ...master, requesterId, referenceNumber: 'EXP-0002', title: 'Second' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="cases-\d{8}\.csv"$/);
    expect(res.headers['x-export-total']).toBe('2');
    expect(res.headers['x-export-truncated']).toBe('false');
    expect(res.body.startsWith('﻿')).toBe(true);
    const rows = lines(res.body);
    expect(rows[0]).toContain('referenceNumber');
    expect(rows[0]).toContain('slaState');
    expect(rows[0]).toContain('caseAgeHours');
    expect(rows).toHaveLength(3);
    expect(res.body).toContain('EXP-0001');
    expect(res.body).toContain('EXP-0002');
    await app.close();
  });

  it('never exports the case description', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, description: 'CONFIDENTIAL DESCRIPTION TEXT 1234567890' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.body).not.toContain('CONFIDENTIAL DESCRIPTION');
    await app.close();
  });

  it('applies the same filters as the list', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    await seedCase(ds, { ...master, requesterId, status: 'Closed' });

    const open = await app.inject({ method: 'GET', url: '/cases/export?open=true', headers: authHeader(app, managerId, 'legal_manager') });
    const closed = await app.inject({ method: 'GET', url: '/cases/export?status=Closed', headers: authHeader(app, managerId, 'legal_manager') });

    expect(lines(open.body)).toHaveLength(2);
    expect(lines(closed.body)).toHaveLength(2);
    expect(open.headers['x-export-total']).toBe('1');
    await app.close();
  });

  it('limits a requester to the cases they can see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const otherRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedCase(ds, { ...master, requesterId, referenceNumber: 'MINE-1' });
    await seedCase(ds, { ...otherMaster, requesterId: otherRequesterId, referenceNumber: 'THEIRS-1' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, requesterId, 'requester') });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('MINE-1');
    expect(res.body).not.toContain('THEIRS-1');
    expect(res.headers['x-export-total']).toBe('1');
    await app.close();
  });

  it('neutralises formula-looking titles and keeps Arabic text and newlines intact', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, title: '=cmd|\' /C calc\'!A0' });
    await seedCase(ds, { ...master, requesterId, title: 'قضية عقد\nسطر ثان' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.body).toContain("'=cmd|");
    expect(res.body).not.toMatch(/,=cmd\|/);
    expect(res.body).toContain('"قضية عقد\nسطر ثان"');
    await app.close();
  });

  it('caps the rows in the query and reports the truncation', async () => {
    const app = buildTestApp(ds, { exportRowCap: 2 });
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    for (let i = 0; i < 3; i += 1) {
      await seedCase(ds, { ...master, requesterId });
    }

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(lines(res.body)).toHaveLength(3);
    expect(res.headers['x-export-total']).toBe('3');
    expect(res.headers['x-export-truncated']).toBe('true');
    await app.close();
  });

  it('lets a viewer export and requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const ok = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, viewerId, 'viewer') });
    const anonymous = await app.inject({ method: 'GET', url: '/cases/export' });

    expect(ok.statusCode).toBe(200);
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });

  it('does not shadow GET /cases/:id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}`, headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(caseRow.id);
    await app.close();
  });
});
