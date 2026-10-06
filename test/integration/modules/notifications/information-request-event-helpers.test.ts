import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { listNotificationsFor } from '../../helpers/seed-notification';
import {
  notifyInformationRequestAnswered,
  notifyInformationRequestRaised,
  notifyInformationRequestReopened,
} from '../../../../src/modules/notifications/notifications.events';

describe('information-request notification helpers', () => {
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

  it('notifyInformationRequestRaised tells the responder and the requester, not the raising rep', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'SECRET SUBJECT LINE' });

    await notifyInformationRequestRaised(ds, caseRow, request);

    const [forResponder] = await listNotificationsFor(ds, responderId);
    const [forRequester] = await listNotificationsFor(ds, requesterId);
    expect(forResponder).toMatchObject({ type: 'info_request.raised', relatedCaseId: caseRow.id });
    expect(forResponder.body).toMatch(/asked to provide information/i);
    expect(forRequester.type).toBe('info_request.raised');
    expect(forRequester.body).toMatch(/information request has been raised/i);
    expect(forResponder.title).toContain(caseRow.referenceNumber);
    expect(forResponder.body).not.toContain('SECRET SUBJECT LINE');
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });

  it('notifyInformationRequestRaised sends one notification when the requester is also the responder', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId });

    await notifyInformationRequestRaised(ds, caseRow, request);

    const rows = await listNotificationsFor(ds, requesterId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/asked to provide information/i);
  });

  it('notifyInformationRequestRaised skips an inactive responder but still tells the requester', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester', { isActive: false });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    await notifyInformationRequestRaised(ds, caseRow, request);

    expect(await listNotificationsFor(ds, responderId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(1);
  });

  it('notifyInformationRequestAnswered tells the assigned rep only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'SECRET ANSWER TEXT' });

    await notifyInformationRequestAnswered(ds, caseRow, request);

    const rows = await listNotificationsFor(ds, repId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'info_request.answered', relatedCaseId: caseRow.id });
    expect(rows[0].body).not.toContain('SECRET ANSWER TEXT');
    expect(await listNotificationsFor(ds, responderId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(0);
  });

  it('notifyInformationRequestAnswered creates nothing and does not throw when the case has no assigned rep', async () => {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: null });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId, status: 'answered', responseText: 'x' });

    await expect(notifyInformationRequestAnswered(ds, caseRow, request)).resolves.toBeUndefined();

    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications`);
    expect(count).toBe(0);
  });

  it('notifyInformationRequestReopened tells the responder only, without the reopen comment', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, requirementDescription: 'SECRET REOPEN COMMENT' });

    await notifyInformationRequestReopened(ds, caseRow, request);

    const rows = await listNotificationsFor(ds, responderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'info_request.reopened', relatedCaseId: caseRow.id });
    expect(rows[0].body).not.toContain('SECRET REOPEN COMMENT');
    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });
});
