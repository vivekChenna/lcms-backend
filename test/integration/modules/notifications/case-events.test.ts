// test/integration/modules/notifications/case-events.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { seedDocument } from '../../helpers/seed-document';
import { listNotificationsFor } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('notifications created by case actions', () => {
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

  // The pre-seeded 'Internal' category is the only one a requester may submit.
  async function internalCategoryAndType() {
    const [category] = await ds.query(`SELECT id FROM case_categories WHERE name = 'Internal'`);
    const [caseType] = await ds.query(
      `INSERT INTO case_types (id, "categoryId", name, "slaAckHours", "slaResolutionHours") VALUES (gen_random_uuid(), $1, $2, 24, 72) RETURNING id`,
      [category.id, `Internal-Type-${Date.now()}-${Math.random()}`],
    );
    return { categoryId: category.id as string, caseTypeId: caseType.id as string };
  }

  function submitPayload(master: { departmentId: string }, ids: { categoryId: string; caseTypeId: string }, title = 'Need contract review') {
    return {
      title,
      description: 'This case description is definitely at least twenty characters.',
      declarationConfirmed: true,
      categoryId: ids.categoryId,
      caseTypeId: ids.caseTypeId,
      departmentId: master.departmentId,
    };
  }

  it('submitting a case with no routing rule registers it: only the requester is notified', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const ids = await internalCategoryAndType();
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload: submitPayload(master, ids) });

    expect(res.statusCode).toBe(201);
    expect(await types(requesterId)).toEqual(['case.registered']);
    expect(await types(managerId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, requesterId);
    expect(row.relatedCaseId).toBe(res.json().id);
    expect(row.body).toContain(res.json().referenceNumber);
    await app.close();
  });

  it('auto-assignment on submit notifies the requester twice (registered, assigned) and the assignee once', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const ids = await internalCategoryAndType();
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
    const assigneeId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 1, true)`,
      [JSON.stringify({ categoryId: ids.categoryId }), assigneeId],
    );

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload: submitPayload(master, ids) });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('Assigned');
    expect(await types(requesterId)).toEqual(['case.registered', 'case.assigned']);
    expect(await types(assigneeId)).toEqual(['case.assigned']);
    await app.close();
  });

  it('a lawyer who submits a case that auto-routes to themselves gets one assignment notification, not two', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 1, true)`,
      [JSON.stringify({ categoryId: master.categoryId }), repId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { ...submitPayload(master, { categoryId: master.categoryId, caseTypeId: master.caseTypeId }), entityId: master.entityId },
    });

    expect(res.statusCode).toBe(201);
    expect(await types(repId)).toEqual(['case.registered', 'case.assigned']);
    await app.close();
  });

  it('a manager assigning a case notifies the assignee and the requester, not the manager', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/assign`, headers: authHeader(app, managerId, 'legal_manager'), payload: { targetLegalRepId: repId } });

    expect(res.statusCode).toBe(200);
    expect(await types(repId)).toEqual(['case.assigned']);
    expect(await types(requesterId)).toEqual(['case.assigned']);
    expect(await types(managerId)).toEqual([]);
    await app.close();
  });

  it('assign, reject, reassign: managers hear about the rejection and the second assignee gets exactly one assignment', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const firstRepId = await seedUserWithRole(ds, 'legal_rep');
    const secondRepId = await seedUserWithRole(ds, 'legal_rep');
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const otherManagerId = await seedUserWithRole(ds, 'legal_manager');

    await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/assign`, headers: authHeader(app, managerId, 'legal_manager'), payload: { targetLegalRepId: firstRepId } });
    const reject = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/reject`, headers: authHeader(app, firstRepId, 'legal_rep'), payload: { reason: 'Conflict of interest' } });
    await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/assign`, headers: authHeader(app, managerId, 'legal_manager'), payload: { targetLegalRepId: secondRepId } });

    expect(reject.statusCode).toBe(200);
    expect(await types(firstRepId)).toEqual(['case.assigned']);
    expect(await types(secondRepId)).toEqual(['case.assigned']);
    for (const id of [managerId, otherManagerId]) {
      const rows = await listNotificationsFor(ds, id);
      expect(rows.map((row) => row.type)).toEqual(['case.rejected']);
      expect(rows[0].body).toContain('Conflict of interest');
    }
    expect((await types(requesterId)).filter((type) => type === 'case.assigned')).toHaveLength(2);
    await app.close();
  });

  it('rejecting when there is no active legal manager still succeeds and creates no manager notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/reject`, headers: authHeader(app, repId, 'legal_rep'), payload: { reason: 'Not my area' } });

    expect(res.statusCode).toBe(200);
    expect(await types(repId)).toEqual([]);
    const [{ count }] = await ds.query('SELECT COUNT(*)::int AS count FROM notifications');
    expect(count).toBe(0);
    await app.close();
  });

  it('accepting a case notifies the requester only', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(200);
    expect(await types(requesterId)).toEqual(['case.accepted']);
    expect(await types(repId)).toEqual([]);
    expect(await types(managerId)).toEqual([]);
    await app.close();
  });

  it('closing a case notifies the requester only', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const [outcome] = await ds.query(`INSERT INTO closure_outcomes (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [`Resolved-${Date.now()}-${Math.random()}`]);
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Closure Document' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { confirm: true, closureSummary: 'Settled.', closureOutcomeId: outcome.id },
    });

    expect(res.statusCode).toBe(200);
    expect(await types(requesterId)).toEqual(['case.closed']);
    expect(await types(repId)).toEqual([]);
    await app.close();
  });

  it('a close blocked by an open information request leaves no notification behind', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const [outcome] = await ds.query(`INSERT INTO closure_outcomes (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [`Resolved-${Date.now()}-${Math.random()}`]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { confirm: true, closureSummary: 'x', closureOutcomeId: outcome.id },
    });

    expect(res.statusCode).toBe(409);
    expect(await types(requesterId)).toEqual([]);
    await app.close();
  });

  it('an inactive requester receives nothing when their case is accepted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, isActive: false });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(200);
    expect(await types(requesterId)).toEqual([]);
    await app.close();
  });
});
