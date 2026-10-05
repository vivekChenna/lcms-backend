import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedComment } from '../../helpers/seed-comment';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';

describe('POST/GET /cases/:id/comments', () => {
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

  async function post(app: ReturnType<typeof buildTestApp>, caseId: string, userId: string, role: string, payload: unknown) {
    return app.inject({ method: 'POST', url: `/cases/${caseId}/comments`, headers: authHeader(app, userId, role), payload: payload as object });
  }

  it('lets the assigned, accepted legal_rep post a visible comment and audits it with the reference number', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, repId, 'legal_rep', { body: 'We have reviewed the contract.' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ caseId: caseRow.id, authorId: repId, body: 'We have reviewed the contract.', isInternal: false });
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'comment.created'`);
    expect(audit.afterValue.referenceNumber).toBe(caseRow.referenceNumber);
    await app.close();
  });

  it('lets a legal_rep post an internal note', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, repId, 'legal_rep', { body: 'Privileged strategy note', isInternal: true });

    expect(res.statusCode).toBe(201);
    expect(res.json().isInternal).toBe(true);
    await app.close();
  });

  it('lets a requester post a visible comment on a case in their own department', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, requesterId, 'requester', { body: 'Please prioritise this.' });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a requester posting an internal note with 403', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, requesterId, 'requester', { body: 'sneaky', isInternal: true });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets a legal_manager comment on a case that is still Submitted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await post(app, caseRow.id, managerId, 'legal_manager', { body: 'Triage note', isInternal: true });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a viewer with 403', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const res = await post(app, caseRow.id, viewerId, 'viewer', { body: 'hello' });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a legal_rep who is not the assigned rep, and one who has not accepted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const notAccepted = await seedCaseWithParties(ds, { status: 'Assigned' });

    const other = await post(app, caseRow.id, otherRepId, 'legal_rep', { body: 'x' });
    const unaccepted = await post(app, notAccepted.caseRow.id, notAccepted.repId, 'legal_rep', { body: 'x' });

    expect(other.statusCode).toBe(403);
    expect(unaccepted.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a comment on a Closed case with 409', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });

    const res = await post(app, caseRow.id, repId, 'legal_rep', { body: 'too late' });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 404 for a requester outside the department who is not a responder', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await post(app, caseRow.id, outsiderId, 'requester', { body: 'hi' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('lets a requester who can see the case only as an information-request responder comment, but not read internal notes', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherMaster = await seedCaseMasterData(ds);
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'internal strategy', isInternal: true });

    const created = await post(app, caseRow.id, responderId, 'requester', { body: 'Answer incoming.' });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, responderId, 'requester') });

    expect(created.statusCode).toBe(201);
    expect(list.statusCode).toBe(200);
    expect(list.json().map((c: { body: string }) => c.body)).toEqual(['Answer incoming.']);
    await app.close();
  });

  it('rejects a whitespace-only or missing body with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const blank = await post(app, caseRow.id, repId, 'legal_rep', { body: '   \n  ' });
    const missing = await post(app, caseRow.id, repId, 'legal_rep', {});

    expect(blank.statusCode).toBe(400);
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it('lists oldest first, excludes deleted rows, and hides internal notes from requesters and viewers', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const viewerId = await seedUserWithRole(ds, 'viewer');
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'first visible' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'internal note', isInternal: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await seedComment(ds, { caseId: caseRow.id, authorId: requesterId, body: 'second visible' });
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'deleted', deletedAt: new Date() });

    const asRep = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, repId, 'legal_rep') });
    const asRequester = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, requesterId, 'requester') });
    const asViewer = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, viewerId, 'viewer') });

    expect(asRep.json().map((c: { body: string }) => c.body)).toEqual(['first visible', 'internal note', 'second visible']);
    expect(asRequester.json().map((c: { body: string }) => c.body)).toEqual(['first visible', 'second visible']);
    expect(asViewer.json().map((c: { body: string }) => c.body)).toEqual(['first visible', 'second visible']);
    await app.close();
  });

  it('returns 404 when listing comments on a case the caller cannot see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, outsiderId, 'requester') });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
