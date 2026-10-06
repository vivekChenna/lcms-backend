// test/integration/modules/notifications/information-request-events.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { listNotificationsFor } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('notifications created by information-request actions', () => {
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

  const types = async (userId: string) => (await listNotificationsFor(ds, userId)).map((row) => row.type);

  it('raising a request notifies the responder and the requester, not the raising rep', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { subject: 'Need clarification', requirementDescription: 'Please confirm the affected unit.', responderId },
    });

    expect(res.statusCode).toBe(201);
    expect(await types(responderId)).toEqual(['info_request.raised']);
    expect(await types(requesterId)).toEqual(['info_request.raised']);
    expect(await types(repId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, responderId);
    expect(row.relatedCaseId).toBe(caseRow.id);
    expect(row.body).not.toContain('Please confirm the affected unit.');
    await app.close();
  });

  it('raising a request whose responder is the requester sends one notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { subject: 's', requirementDescription: 'd', responderId: requesterId },
    });

    expect(res.statusCode).toBe(201);
    expect(await types(requesterId)).toEqual(['info_request.raised']);
    await app.close();
  });

  it('answering a request notifies the assigned rep only', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${request.id}/respond`,
      headers: authHeader(app, responderId, 'requester'),
      payload: { responseText: 'The affected unit is Operations.' },
    });

    expect(res.statusCode).toBe(200);
    expect(await types(repId)).toEqual(['info_request.answered']);
    expect(await types(responderId)).toEqual([]);
    expect(await types(requesterId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, repId);
    expect(row.body).not.toContain('Operations');
    await app.close();
  });

  it('answering on a case that has no assigned rep still succeeds and notifies nobody', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const raiserId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: null });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: raiserId, responderId: requesterId });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${request.id}/respond`,
      headers: authHeader(app, requesterId, 'requester'),
      payload: { responseText: 'done' },
    });

    expect(res.statusCode).toBe(200);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications`);
    expect(count).toBe(0);
    await app.close();
  });

  it('reopening a request notifies the responder only, not the raising rep or the requester', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'thin answer' });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { comment: 'This does not name the business unit.' },
    });

    expect(res.statusCode).toBe(200);
    expect(await types(responderId)).toEqual(['info_request.reopened']);
    expect(await types(repId)).toEqual([]);
    expect(await types(requesterId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, responderId);
    expect(row.body).not.toContain('business unit');
    await app.close();
  });

  it('a rejected raise (wrong rep) creates no notifications', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester');

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, otherRepId, 'legal_rep'),
      payload: { subject: 's', requirementDescription: 'd', responderId },
    });

    expect(res.statusCode).toBe(403);
    expect(await types(responderId)).toEqual([]);
    expect(await types(requesterId)).toEqual([]);
    await app.close();
  });
});
