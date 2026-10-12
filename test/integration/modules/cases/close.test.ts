import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { seedDocument } from '../../helpers/seed-document';
import { resetDatabase } from '../../helpers/reset-db';

describe('PATCH /cases/:id/close', () => {
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
    await ds.query('DELETE FROM closure_outcomes');
  }

  async function seedOutcome(): Promise<string> {
    const [row] = await ds.query(`INSERT INTO closure_outcomes (id, name) VALUES (gen_random_uuid(), 'Resolved') RETURNING id`);
    return row.id;
  }

  it('lets the assigned legal_rep close an In Progress case (WF-11/WF-12)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const outcomeId = await seedOutcome();
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Closure Document' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: true, closureSummary: 'Matter resolved via negotiated settlement.', closureOutcomeId: outcomeId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('Closed');
    expect(res.json().closedAt).not.toBeNull();
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.closed'`);
    expect(auditRows).toHaveLength(1);
    await app.close();
  });

  it('refuses to close without a closure document, and ignores deleted ones and other categories', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const outcomeId = await seedOutcome();
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Evidence' });
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Closure Document', deletedAt: new Date() });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: true, closureSummary: 'Matter resolved via negotiated settlement.', closureOutcomeId: outcomeId },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/closure document/i);
    const [after] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(after.status).toBe('In Progress');
    await app.close();
  });

  it('rejects closing a case that is still Submitted (VC-14)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    const outcomeId = await seedOutcome();
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: true, closureSummary: 'x', closureOutcomeId: outcomeId },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects a legal_rep closing a case not assigned to them', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId });
    const outcomeId = await seedOutcome();
    const token = app.signAccessToken({ id: otherRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: true, closureSummary: 'x', closureOutcomeId: outcomeId },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects closing without confirm: true (VC-13)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId });
    const outcomeId = await seedOutcome();
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: false, closureSummary: 'x', closureOutcomeId: outcomeId },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an unknown closureOutcomeId with 400, not a raw 500 from the FK constraint', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: true, closureSummary: 'Matter resolved via negotiated settlement.', closureOutcomeId: '00000000-0000-0000-0000-000000000000' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects closing a case with an open information request (VC-12)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'open' });
    const outcomeId = await seedOutcome();
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: true, closureSummary: 'x', closureOutcomeId: outcomeId },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('concurrent raise and close on the same case never both succeed (case row lock closes the VC-12 race)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const outcomeId = await seedOutcome();
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const [closeRes, raiseRes] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/cases/${caseRow.id}/close`,
        headers: { authorization: `Bearer ${token}` },
        payload: { confirm: true, closureSummary: 'x', closureOutcomeId: outcomeId },
      }),
      app.inject({
        method: 'POST',
        url: `/cases/${caseRow.id}/information-requests`,
        headers: { authorization: `Bearer ${token}` },
        payload: { subject: 'Need clarification', requirementDescription: 'x', responderId },
      }),
    ]);

    // Whichever transaction's lock wins, the other must see the committed
    // result and reject cleanly — never both succeed, and never a Closed
    // case with an open information request. Exactly one of (close: 200,
    // raise: 201) happens; the loser always gets 409.
    const succeeded = [closeRes.statusCode === 200, raiseRes.statusCode === 201].filter(Boolean);
    expect(succeeded).toHaveLength(1);
    if (closeRes.statusCode !== 200) expect(closeRes.statusCode).toBe(409);
    if (raiseRes.statusCode !== 201) expect(raiseRes.statusCode).toBe(409);

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    const [{ count: openCount }] = await ds.query(
      `SELECT COUNT(*)::int AS count FROM information_requests WHERE "caseId" = $1 AND status = 'open'`,
      [caseRow.id],
    );
    if (caseAfter.status === 'Closed') {
      expect(openCount).toBe(0);
    } else {
      expect(caseAfter.status).toBe('Waiting on Input');
      expect(openCount).toBe(1);
    }
    await app.close();
  });
});
