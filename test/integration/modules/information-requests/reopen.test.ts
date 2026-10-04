import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { resetDatabase } from '../../helpers/reset-db';

describe('POST /information-requests/:id/reopen', () => {
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

  it('lets the raiser reopen an answered request, creating a new row and superseding the old one', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'Insufficient answer' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'This does not specify which business unit — please clarify.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('open');
    expect(res.json().reopenedFromId).toBe(answered.id);
    expect(res.json().requirementDescription).toBe('This does not specify which business unit — please clarify.');
    expect(res.json().id).not.toBe(answered.id);

    const [supersededRow] = await ds.query(`SELECT status FROM information_requests WHERE id = $1`, [answered.id]);
    expect(supersededRow.status).toBe('superseded');

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('forces Waiting on Input even when the case is already back In Progress with no other open requests', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'reopening' },
    });

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('rejects reopening by someone other than the original raiser', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const token = app.signAccessToken({ id: otherRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'x' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects reopening on a Closed case with 409 and writes nothing (no partial IR writes)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Closed', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'reopening after closure' },
    });

    expect(res.statusCode).toBe(409);
    const rows = await ds.query(`SELECT id, status FROM information_requests WHERE "caseId" = $1`, [caseRow.id]);
    expect(rows).toEqual([{ id: answered.id, status: 'answered' }]);
    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Closed');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'info_request.reopened'`);
    expect(auditRows).toHaveLength(0);
    await app.close();
  });

  it('records referenceNumber in both before and after of the info_request.reopened audit entry', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'reopening' },
    });

    expect(res.statusCode).toBe(200);
    const [audit] = await ds.query(`SELECT "beforeValue", "afterValue" FROM audit_log WHERE action = 'info_request.reopened'`);
    expect(audit.beforeValue.referenceNumber).toBe(caseRow.referenceNumber);
    expect(audit.afterValue.referenceNumber).toBe(caseRow.referenceNumber);
    await app.close();
  });

  it('rejects reopening a request that is still open', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const openRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'open' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${openRequest.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'x' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
