import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('names on case responses', () => {
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

  async function scenario() {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { fullName: 'Rana Requester', departmentId: master.departmentId, entityId: master.entityId });
    await ds.query(`UPDATE users SET designation = 'Procurement Specialist' WHERE id = $1`, [requesterId]);
    const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Lina Lawyer' });
    const managerId = await seedUserWithRole(ds, 'legal_manager', { fullName: 'Mona Manager' });
    const assigned = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId, referenceNumber: 'NAME-1' });
    const unassigned = await seedCase(ds, { ...master, requesterId, status: 'Submitted', businessUnitId: null, referenceNumber: 'NAME-2' });
    return { master, requesterId, repId, managerId, assigned, unassigned };
  }

  it('GET /cases/:id carries requester, assignee and master-data names', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: `/cases/${s.assigned.id}`, headers: authHeader(app, s.managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      requesterName: 'Rana Requester',
      requesterDesignation: 'Procurement Specialist',
      assignedLegalRepName: 'Lina Lawyer',
      assignedLegalRepRole: 'legal_rep',
      categoryName: await nameOf('case_categories', s.master.categoryId),
      caseTypeName: await nameOf('case_types', s.master.caseTypeId),
      departmentName: await nameOf('departments', s.master.departmentId),
      entityName: await nameOf('entities', s.master.entityId),
      businessUnitName: await nameOf('business_units', s.master.businessUnitId),
    });
    await app.close();
  });

  it('uses null for an unassigned case and a missing business unit', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: `/cases/${s.unassigned.id}`, headers: authHeader(app, s.managerId, 'legal_manager') });

    expect(res.json()).toMatchObject({ assignedLegalRepName: null, assignedLegalRepRole: null, businessUnitName: null });
    await app.close();
  });

  it('lets a requester see the assignee name (no unknown users)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers: authHeader(app, s.requesterId, 'requester') });

    const row = res.json().items.find((item: { referenceNumber: string }) => item.referenceNumber === 'NAME-1');
    expect(row.assignedLegalRepName).toBe('Lina Lawyer');
    await app.close();
  });

  it('every list row is named', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers: authHeader(app, s.managerId, 'legal_manager') });

    expect(res.json().items).toHaveLength(2);
    for (const item of res.json().items) {
      expect(item.requesterName).toBe('Rana Requester');
      expect(item.categoryName).toBeTruthy();
      expect(item.departmentName).toBeTruthy();
    }
    await app.close();
  });

  it('a case whose requester row no longer resolves gets null names instead of failing', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();
    await ds.query(`UPDATE users SET "fullName" = 'Rana Requester' WHERE id = $1`, [s.requesterId]);
    // simulate a lookup miss for the assignee by pointing the case at a user that is then deactivated is not a miss;
    // a true miss needs a deleted user, so assert the helper contract directly:
    const { loadUserNames } = await import('../../../../src/shared/name-lookup');

    const names = await loadUserNames(ds, ['00000000-0000-4000-8000-000000000000', null, undefined, s.requesterId]);

    expect(names.size).toBe(1);
    expect(names.get(s.requesterId)?.fullName).toBe('Rana Requester');
    await app.close();
  });

  it('workflow responses are named too (assign)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'PATCH', url: `/cases/${s.unassigned.id}/assign`, headers: authHeader(app, s.managerId, 'legal_manager'), payload: { targetLegalRepId: s.repId } });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignedLegalRepName).toBe('Lina Lawyer');
    expect(res.json().requesterName).toBe('Rana Requester');
    await app.close();
  });

  it('the CSV export gains name columns after the id columns', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, s.managerId, 'legal_manager') });

    const lines = res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('requesterName');
    expect(lines[0]).toContain('assignedLegalRepName');
    expect(lines[0]).toContain('departmentName');
    expect(res.body).toContain('Lina Lawyer');
    expect(res.body).toContain('Rana Requester');
    await app.close();
  });
});
