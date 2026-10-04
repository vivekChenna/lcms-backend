import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';

describe('PATCH /cases/:id/accept and /reject', () => {
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

  async function reset() {
    await resetDatabase(ds);
  }

  it('lets the assigned legal_rep accept, moving to In Progress and stamping acceptance', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('In Progress');
    expect(res.json().assignmentAcceptedAt).not.toBeNull();
    await app.close();
  });

  it('rejects accept from a legal_rep the case is not assigned to', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });
    const token = app.signAccessToken({ id: otherRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets the assigned legal_rep reject with a reason, returning the case to Submitted unassigned', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Conflict of interest' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('Submitted');
    expect(res.json().assignedLegalRepId).toBeNull();
    await app.close();
  });

  it('rejects a rejection reason shorter than 3 characters (VC-08)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'no' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lets a legal_manager who is the assignee accept a case (VC-07 can target a legal_manager)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: managerId });
    const token = app.signAccessToken({ id: managerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('In Progress');
    expect(res.json().assignmentAcceptedAt).not.toBeNull();
    await app.close();
  });

  it('rejects accepting a case that is not currently Assigned', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
