import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
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
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
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
