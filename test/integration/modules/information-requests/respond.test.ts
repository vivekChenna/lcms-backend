import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { resetDatabase } from '../../helpers/reset-db';
import { seedInformationRequest } from '../../helpers/seed-information-request';

describe('POST /information-requests/:id/respond', () => {
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

  it('lets the responder answer, returning the case to In Progress when it was the only open request', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'The affected business unit is Operations.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('answered');
    expect(res.json().responseText).toBe('The affected business unit is Operations.');

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('In Progress');
    await app.close();
  });

  it('leaves the case Waiting on Input when another open request remains', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const firstRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'Second question' });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${firstRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'Answering the first one.' },
    });

    expect(res.statusCode).toBe(200);
    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('does not silently accept a reassigned (Assigned) case: responding rejects with 409 and writes nothing', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const newRepId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    // Case was reassigned (Waiting on Input -> Assigned) while the request was still open.
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: newRepId, assignmentAcceptedAt: null });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'Answer after reassignment' },
    });

    expect(res.statusCode).toBe(409);
    const [caseAfter] = await ds.query(`SELECT status, "assignmentAcceptedAt" FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Assigned');
    expect(caseAfter.assignmentAcceptedAt).toBeNull();
    const [irAfter] = await ds.query(`SELECT status, "responseText" FROM information_requests WHERE id = $1`, [infoRequest.id]);
    expect(irAfter).toEqual({ status: 'open', responseText: null });
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action IN ('case.resumed_in_progress', 'info_request.answered')`);
    expect(auditRows).toHaveLength(0);
    await app.close();
  });

  it('records referenceNumber, before status, and responseText in the info_request.answered audit entry', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'Operations.' },
    });

    expect(res.statusCode).toBe(200);
    const [audit] = await ds.query(`SELECT "beforeValue", "afterValue" FROM audit_log WHERE action = 'info_request.answered'`);
    expect(audit.beforeValue).toEqual({ id: infoRequest.id, status: 'open' });
    expect(audit.afterValue).toMatchObject({
      id: infoRequest.id,
      caseId: caseRow.id,
      referenceNumber: caseRow.referenceNumber,
      responseText: 'Operations.',
    });
    await app.close();
  });

  it('two concurrent responses to the last two open requests leave the case In Progress', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const first = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const second = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'Second question' });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const [resA, resB] = await Promise.all(
      [first, second].map((ir) =>
        app.inject({
          method: 'POST',
          url: `/information-requests/${ir.id}/respond`,
          headers: { authorization: `Bearer ${token}` },
          payload: { responseText: 'answer' },
        }),
      ),
    );

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('In Progress');
    await app.close();
  });

  it('rejects a response from anyone other than the assigned responder', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const someoneElseId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const token = app.signAccessToken({ id: someoneElseId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'x' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects responding to an already-answered request', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'already answered' });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'trying again' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('lets a responder holding the legal_rep role respond (PR-11: responder can be any role)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderRepId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: responderRepId });
    const token = app.signAccessToken({ id: responderRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'Responding as a legal_rep, not a requester.' },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
