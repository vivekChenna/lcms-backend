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
const DAY = 24 * HOUR;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

describe('SLA compliance and ageing reports', () => {
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

  async function parties() {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    return { master, requesterId, managerId };
  }

  describe('GET /reports/sla-compliance', () => {
    it('counts closed on time / late and open on track / at risk / breached', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId, managerId } = await parties();
      const base = { ...master, requesterId };
      // closed on time x2, closed late x1
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(10), resolutionDueAt: inHours(-24), closedAt: inHours(-48) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(10), resolutionDueAt: inHours(-24), closedAt: inHours(-24) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(10), resolutionDueAt: inHours(-48), closedAt: inHours(-24) });
      // open: on track (far future), at risk (due in 1h of a 100h window), breached (past)
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: inHours(-10), resolutionDueAt: inHours(90) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: inHours(-99), resolutionDueAt: inHours(1) });
      await seedCaseWithTimes(ds, { ...base, status: 'Submitted', createdAt: inHours(-50), resolutionDueAt: inHours(-1) });

      const res = await app.inject({ method: 'GET', url: '/reports/sla-compliance', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        closedOnTime: 2,
        closedLate: 1,
        openOnTrack: 1,
        openAtRisk: 1,
        openBreached: 1,
        compliancePercent: 66.7,
      });
      await app.close();
    });

    it('returns zeros and a null percentage when nothing is closed', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await parties();

      const res = await app.inject({ method: 'GET', url: '/reports/sla-compliance', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.json()).toEqual({ closedOnTime: 0, closedLate: 0, openOnTrack: 0, openAtRisk: 0, openBreached: 0, compliancePercent: null });
      await app.close();
    });

    it('narrows by date range and by case filters', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId, managerId } = await parties();
      const otherMaster = await seedCaseMasterData(ds);
      const base = { ...master, requesterId };
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: new Date('2026-01-10T00:00:00Z'), resolutionDueAt: new Date('2026-01-20T00:00:00Z'), closedAt: new Date('2026-01-15T00:00:00Z') });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: new Date('2026-03-10T00:00:00Z'), resolutionDueAt: new Date('2026-03-12T00:00:00Z'), closedAt: new Date('2026-03-15T00:00:00Z') });
      await seedCaseWithTimes(ds, { ...otherMaster, requesterId, status: 'Closed', createdAt: new Date('2026-01-11T00:00:00Z'), resolutionDueAt: new Date('2026-01-20T00:00:00Z'), closedAt: new Date('2026-01-15T00:00:00Z') });
      const headers = authHeader(app, managerId, 'legal_manager');

      const january = await app.inject({ method: 'GET', url: '/reports/sla-compliance?createdFrom=2026-01-01T00:00:00Z&createdTo=2026-02-01T00:00:00Z', headers });
      const january1 = await app.inject({ method: 'GET', url: `/reports/sla-compliance?createdFrom=2026-01-01T00:00:00Z&createdTo=2026-02-01T00:00:00Z&categoryId=${master.categoryId}`, headers });

      expect(january.json().closedOnTime).toBe(2);
      expect(january1.json().closedOnTime).toBe(1);
      await app.close();
    });

    it('rejects createdFrom after createdTo and invalid values with 400', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await parties();
      const headers = authHeader(app, managerId, 'legal_manager');

      const reversed = await app.inject({ method: 'GET', url: '/reports/sla-compliance?createdFrom=2026-03-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z', headers });
      const garbage = await app.inject({ method: 'GET', url: '/reports/sla-compliance?createdFrom=yesterday-ish', headers });
      const badUuid = await app.inject({ method: 'GET', url: '/reports/sla-compliance?categoryId=nope', headers });

      expect(reversed.statusCode).toBe(400);
      expect(garbage.statusCode).toBe(400);
      expect(badUuid.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('GET /reports/ageing', () => {
    it('buckets open cases by age and ignores closed ones, with all four buckets always present', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId, managerId } = await parties();
      const base = { ...master, requesterId, resolutionDueAt: inHours(500) };
      // age boundaries: 7d23h -> 0-7, 8d1h -> 8-30, 30d23h -> 8-30, 31d1h -> 31-90, 90d23h -> 31-90, 91d1h -> 91+
      await seedCaseWithTimes(ds, { ...base, status: 'Submitted', createdAt: new Date(Date.now() - (8 * DAY - HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Assigned', createdAt: new Date(Date.now() - (8 * DAY + HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: new Date(Date.now() - (31 * DAY - HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: new Date(Date.now() - (31 * DAY + HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', createdAt: new Date(Date.now() - (91 * DAY - HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', createdAt: new Date(Date.now() - (91 * DAY + HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(200), closedAt: daysAgo(1) });

      const res = await app.inject({ method: 'GET', url: '/reports/ageing', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { bucket: '0-7', count: 1 },
        { bucket: '8-30', count: 2 },
        { bucket: '31-90', count: 2 },
        { bucket: '91+', count: 1 },
      ]);
      await app.close();
    });

    it('returns four zero buckets when there are no open cases', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await parties();

      const res = await app.inject({ method: 'GET', url: '/reports/ageing', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.json()).toEqual([
        { bucket: '0-7', count: 0 },
        { bucket: '8-30', count: 0 },
        { bucket: '31-90', count: 0 },
        { bucket: '91+', count: 0 },
      ]);
      await app.close();
    });
  });

  describe('access and export', () => {
    it('allows admin, legal manager and viewer and forbids legal rep and requester on the JSON and export routes', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      for (const url of ['/reports/sla-compliance', '/reports/sla-compliance/export', '/reports/ageing', '/reports/ageing/export']) {
        for (const role of ['admin', 'legal_manager', 'viewer'] as const) {
          const userId = await seedUserWithRole(ds, role);
          const res = await app.inject({ method: 'GET', url, headers: authHeader(app, userId, role) });
          expect(res.statusCode, `${role} ${url}`).toBe(200);
        }
        for (const role of ['legal_rep', 'requester'] as const) {
          const userId = await seedUserWithRole(ds, role);
          const res = await app.inject({ method: 'GET', url, headers: authHeader(app, userId, role) });
          expect(res.statusCode, `${role} ${url}`).toBe(403);
        }
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      }
      await app.close();
    });

    it('exports the SLA compliance report as a one-row CSV and the ageing report as four rows', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId } = await parties();
      const viewerId = await seedUserWithRole(ds, 'viewer');
      await seedCaseWithTimes(ds, { ...master, requesterId, status: 'Closed', createdAt: daysAgo(5), resolutionDueAt: inHours(-24), closedAt: inHours(-48) });
      const headers = authHeader(app, viewerId, 'viewer');

      const sla = await app.inject({ method: 'GET', url: '/reports/sla-compliance/export', headers });
      const ageing = await app.inject({ method: 'GET', url: '/reports/ageing/export', headers });

      const slaLines = sla.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(sla.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(sla.headers['content-disposition']).toMatch(/^attachment; filename="sla-compliance-\d{8}\.csv"$/);
      expect(sla.body.startsWith('﻿')).toBe(true);
      expect(slaLines[0]).toBe('closedOnTime,closedLate,openOnTrack,openAtRisk,openBreached,compliancePercent');
      expect(slaLines[1]).toBe('1,0,0,0,0,100');
      const ageingLines = ageing.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(ageingLines).toEqual(['bucket,count', '0-7,0', '8-30,0', '31-90,0', '91+,0']);
      await app.close();
    });
  });
});
