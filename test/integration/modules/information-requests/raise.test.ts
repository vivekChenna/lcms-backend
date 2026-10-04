import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { resetDatabase } from '../../helpers/reset-db';

describe('POST /cases/:id/information-requests', () => {
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

  it('lets the assigned, accepted legal_rep raise a request, moving the case to Waiting on Input', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'Need clarification', requirementDescription: 'Please confirm the affected business unit.', responderId },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('open');
    expect(res.json().responderId).toBe(responderId);

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'info_request.raised'`);
    expect(auditRows).toHaveLength(1);
    await app.close();
  });

  it('allows raising a second concurrent request while the case is already Waiting on Input (WF-08)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'Second question', requirementDescription: 'A second, independent question.', responderId },
    });

    expect(res.statusCode).toBe(201);
    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('rejects a legal_rep raising a request on a case not assigned to them', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: otherRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'x', requirementDescription: 'x', responderId },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects raising a request on an Assigned case (not yet accepted)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'x', requirementDescription: 'x', responderId },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
