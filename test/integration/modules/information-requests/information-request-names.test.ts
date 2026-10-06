import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';

describe('information request names', () => {
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

  async function scenario() {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Rita Rep' });
    const responderId = await seedUserWithRole(ds, 'requester', { fullName: 'Omar Responder', departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    return { repId, responderId, caseRow };
  }
  const expected = { raisedByName: 'Rita Rep', raisedByRole: 'legal_rep', responderName: 'Omar Responder' };

  it('list and raise carry the names', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, responderId, caseRow } = await scenario();
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/information-requests`, headers: authHeader(app, repId, 'legal_rep') });
    const raised = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { subject: 'S', requirementDescription: 'D', responderId },
    });

    expect(list.json()[0]).toMatchObject(expected);
    expect(raised.statusCode).toBe(201);
    expect(raised.json()).toMatchObject(expected);
    await app.close();
  });

  it('respond and reopen carry the names', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, responderId, caseRow } = await scenario();
    const open = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const answeredRow = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'meh' });

    const responded = await app.inject({ method: 'POST', url: `/information-requests/${open.id}/respond`, headers: authHeader(app, responderId, 'requester'), payload: { responseText: 'Done' } });
    const reopened = await app.inject({ method: 'POST', url: `/information-requests/${answeredRow.id}/reopen`, headers: authHeader(app, repId, 'legal_rep'), payload: { comment: 'More please' } });

    expect(responded.statusCode).toBe(200);
    expect(responded.json()).toMatchObject(expected);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject(expected);
    await app.close();
  });
});
