import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';

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
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM closure_outcomes');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
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
});
