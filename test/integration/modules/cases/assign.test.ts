import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';

describe('PATCH /cases/:id/assign', () => {
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
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('assigns a Submitted case to a legal_rep (legal_manager)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId });
    const token = app.signAccessToken({ id: managerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { targetLegalRepId: repId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('Assigned');
    expect(res.json().assignedLegalRepId).toBe(repId);

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.assigned'`);
    expect(auditRows).toHaveLength(1);
    await app.close();
  });

  it('rejects assignment to a requester (VC-07)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId });
    const token = app.signAccessToken({ id: managerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { targetLegalRepId: requesterId },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a legal_rep calling the assign endpoint', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { targetLegalRepId: repId },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('reassigns an already-Assigned case to a different legal_rep, resetting acceptance (PR-23)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const repA = await seedUserWithRole(ds, 'legal_rep');
    const repB = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, {
      ...master,
      requesterId,
      status: 'In Progress',
      assignedLegalRepId: repA,
      assignmentAcceptedAt: new Date(),
    });
    const token = app.signAccessToken({ id: managerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { targetLegalRepId: repB },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('Assigned');
    expect(res.json().assignedLegalRepId).toBe(repB);
    expect(res.json().assignmentAcceptedAt).toBeNull();
    await app.close();
  });

  it('rejects assigning a Closed case', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Closed' });
    const token = app.signAccessToken({ id: managerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { targetLegalRepId: repId },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
