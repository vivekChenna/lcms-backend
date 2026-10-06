// test/integration/modules/dashboards-reports/reports-volume-workload.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithTimes } from '../../helpers/seed-case-times';
import { authHeader } from '../../helpers/auth-header';

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

describe('volume and workload reports', () => {
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

  const nameOf = async (table: string, id: string) => (await ds.query(`SELECT name FROM ${table} WHERE id = $1`, [id]))[0].name as string;

  async function twoMasters() {
    const first = await seedCaseMasterData(ds);
    const second = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: first.departmentId, entityId: first.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    return { first, second, requesterId, managerId };
  }

  describe('GET /reports/volume-by-category', () => {
    it('counts every case per category and type with names, largest first', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, second, requesterId, managerId } = await twoMasters();
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'Submitted' });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'Closed' });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress' });
      await seedCaseWithTimes(ds, { ...second, requesterId, status: 'Submitted' });

      const res = await app.inject({ method: 'GET', url: '/reports/volume-by-category', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { categoryId: first.categoryId, categoryName: await nameOf('case_categories', first.categoryId), caseTypeId: first.caseTypeId, caseTypeName: await nameOf('case_types', first.caseTypeId), count: 3 },
        { categoryId: second.categoryId, categoryName: await nameOf('case_categories', second.categoryId), caseTypeId: second.caseTypeId, caseTypeName: await nameOf('case_types', second.caseTypeId), count: 1 },
      ]);
      await app.close();
    });

    it('returns an empty list when nothing matches and honours filters', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, second, requesterId, managerId } = await twoMasters();
      await seedCaseWithTimes(ds, { ...first, requesterId });
      await seedCaseWithTimes(ds, { ...second, requesterId });
      const headers = authHeader(app, managerId, 'legal_manager');

      const filtered = await app.inject({ method: 'GET', url: `/reports/volume-by-category?categoryId=${second.categoryId}`, headers });
      const none = await app.inject({ method: 'GET', url: '/reports/volume-by-category?status=Closed', headers });

      expect(filtered.json()).toHaveLength(1);
      expect(filtered.json()[0].categoryId).toBe(second.categoryId);
      expect(none.json()).toEqual([]);
      await app.close();
    });
  });

  describe('GET /reports/volume-by-organisation', () => {
    it('counts per entity, business unit and department, allowing a missing business unit', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, second, requesterId, managerId } = await twoMasters();
      await seedCaseWithTimes(ds, { ...first, requesterId });
      await seedCaseWithTimes(ds, { ...first, requesterId });
      await seedCaseWithTimes(ds, { ...second, requesterId, businessUnitId: null });

      const res = await app.inject({ method: 'GET', url: '/reports/volume-by-organisation', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          entityId: first.entityId,
          entityName: await nameOf('entities', first.entityId),
          businessUnitId: first.businessUnitId,
          businessUnitName: await nameOf('business_units', first.businessUnitId),
          departmentId: first.departmentId,
          departmentName: await nameOf('departments', first.departmentId),
          count: 2,
        },
        {
          entityId: second.entityId,
          entityName: await nameOf('entities', second.entityId),
          businessUnitId: null,
          businessUnitName: null,
          departmentId: second.departmentId,
          departmentName: await nameOf('departments', second.departmentId),
          count: 1,
        },
      ]);
      await app.close();
    });
  });

  describe('GET /reports/rep-workload', () => {
    it('counts open, awaiting-acceptance and overdue cases per rep and skips closed and unassigned cases', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, requesterId, managerId } = await twoMasters();
      const busyRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Busy Rep' });
      const quietRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Quiet Rep' });
      const idleRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Idle Rep' });
      const base = { ...first, requesterId };
      await seedCaseWithTimes(ds, { ...base, status: 'Assigned', assignedLegalRepId: busyRepId, resolutionDueAt: inHours(48) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: busyRepId, resolutionDueAt: inHours(-2) });
      await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', assignedLegalRepId: busyRepId, resolutionDueAt: inHours(48) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: quietRepId, resolutionDueAt: inHours(48) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: idleRepId, resolutionDueAt: inHours(-48), closedAt: inHours(-1) });
      await seedCaseWithTimes(ds, { ...base, status: 'Submitted', assignedLegalRepId: null, resolutionDueAt: inHours(-5) });

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { legalRepId: busyRepId, fullName: 'Busy Rep', openCount: 3, awaitingAcceptanceCount: 1, overdueCount: 1 },
        { legalRepId: quietRepId, fullName: 'Quiet Rep', openCount: 1, awaitingAcceptanceCount: 0, overdueCount: 0 },
      ]);
      await app.close();
    });

    it('returns an empty list when no rep has open work', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await twoMasters();

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.json()).toEqual([]);
      await app.close();
    });
  });

  describe('access and export', () => {
    it('forbids legal rep and requester and allows viewer on every route and export', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      for (const base of ['/reports/volume-by-category', '/reports/volume-by-organisation', '/reports/rep-workload']) {
        for (const url of [base, `${base}/export`]) {
          const viewerId = await seedUserWithRole(ds, 'viewer');
          const repId = await seedUserWithRole(ds, 'legal_rep');
          const requesterId = await seedUserWithRole(ds, 'requester');
          expect((await app.inject({ method: 'GET', url, headers: authHeader(app, viewerId, 'viewer') })).statusCode, url).toBe(200);
          expect((await app.inject({ method: 'GET', url, headers: authHeader(app, repId, 'legal_rep') })).statusCode, url).toBe(403);
          expect((await app.inject({ method: 'GET', url, headers: authHeader(app, requesterId, 'requester') })).statusCode, url).toBe(403);
          expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
        }
      }
      await app.close();
    });

    it('exports the same rows as the JSON route, with a header, quoting names with commas and neutralising formulas', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, requesterId, managerId } = await twoMasters();
      const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: '=HYPERLINK("http://evil")' });
      const otherRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Smith, Jane' });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: repId });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: otherRepId });
      const headers = authHeader(app, managerId, 'legal_manager');

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload/export', headers });

      const lines = res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(lines[0]).toBe('legalRepId,fullName,openCount,awaitingAcceptanceCount,overdueCount');
      expect(lines).toHaveLength(3);
      expect(res.body).toContain('"Smith, Jane"');
      expect(res.body).toContain(`'=HYPERLINK`);
      expect(res.body).not.toMatch(/,=HYPERLINK/);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="rep-workload-\d{8}\.csv"$/);
      await app.close();
    });

    it('truncates an export beyond the cap and says so', async () => {
      const app = buildTestApp(ds, { exportRowCap: 1 });
      await app.ready();
      const { first, requesterId, managerId } = await twoMasters();
      const repA = await seedUserWithRole(ds, 'legal_rep');
      const repB = await seedUserWithRole(ds, 'legal_rep');
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: repA });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: repB });

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload/export', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean)).toHaveLength(2);
      expect(res.headers['x-export-total']).toBe('2');
      expect(res.headers['x-export-truncated']).toBe('true');
      await app.close();
    });
  });
});
