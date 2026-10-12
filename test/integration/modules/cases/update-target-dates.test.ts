import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { authHeader } from '../../helpers/auth-header';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { resetDatabase } from '../../helpers/reset-db';
import { listNotificationsFor } from '../../helpers/seed-notification';

describe('PATCH /cases/:id/target-dates (PR-19)', () => {
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

  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  async function world(status: 'In Progress' | 'Closed' = 'In Progress') {
    await resetDatabase(ds);
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const adminId = await seedUserWithRole(ds, 'admin');
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status, assignedLegalRepId: repId, assignmentAcceptedAt: new Date(), ...(status === 'Closed' ? { closedAt: new Date() } : {}) });
    const app = buildTestApp(ds);
    await app.ready();
    return { app, managerId, adminId, repId, requesterId, caseRow };
  }

  it('lets a manager move the resolution date and records the change with its reason', async () => {
    const w = await world();
    const newDate = inDays(30);

    const res = await w.app.inject({
      method: 'PATCH',
      url: `/cases/${w.caseRow.id}/target-dates`,
      headers: authHeader(w.app, w.managerId, 'legal_manager'),
      payload: { resolutionDueAt: newDate, reason: 'Counterparty asked for more time' },
    });

    expect(res.statusCode).toBe(200);
    expect(new Date(res.json().resolutionDueAt).getTime()).toBe(new Date(newDate).getTime());
    const [audit] = await ds.query(`SELECT "actorId", "beforeValue", "afterValue" FROM audit_log WHERE action = 'case.target_dates_changed'`);
    expect(audit.actorId).toBe(w.managerId);
    expect(audit.afterValue.reason).toBe('Counterparty asked for more time');
    expect(audit.beforeValue.resolutionDueAt).toBeTruthy();
    await w.app.close();
  });

  it('tells the assigned lawyer and the requester, but not the manager who made the change', async () => {
    const w = await world();

    await w.app.inject({
      method: 'PATCH',
      url: `/cases/${w.caseRow.id}/target-dates`,
      headers: authHeader(w.app, w.managerId, 'legal_manager'),
      payload: { resolutionDueAt: inDays(30), reason: 'Counterparty asked for more time' },
    });

    const [forRep] = await listNotificationsFor(ds, w.repId);
    const [forRequester] = await listNotificationsFor(ds, w.requesterId);
    expect(forRep.type).toBe('case.target_dates_changed');
    expect(forRep.body).toContain('Counterparty asked for more time');
    expect(forRequester.type).toBe('case.target_dates_changed');
    expect(await listNotificationsFor(ds, w.managerId)).toHaveLength(0);
    await w.app.close();
  });

  it('lets an admin change both dates', async () => {
    const w = await world();

    const res = await w.app.inject({
      method: 'PATCH',
      url: `/cases/${w.caseRow.id}/target-dates`,
      headers: authHeader(w.app, w.adminId, 'admin'),
      payload: { ackDueAt: inDays(2), resolutionDueAt: inDays(20), reason: 'Re-planned' },
    });

    expect(res.statusCode).toBe(200);
    await w.app.close();
  });

  it('refuses a legal rep and a requester', async () => {
    const w = await world();
    const body = { resolutionDueAt: inDays(30), reason: 'Please' };

    const asRep = await w.app.inject({ method: 'PATCH', url: `/cases/${w.caseRow.id}/target-dates`, headers: authHeader(w.app, w.repId, 'legal_rep'), payload: body });
    const asRequester = await w.app.inject({ method: 'PATCH', url: `/cases/${w.caseRow.id}/target-dates`, headers: authHeader(w.app, w.requesterId, 'requester'), payload: body });

    expect(asRep.statusCode).toBe(403);
    expect(asRequester.statusCode).toBe(403);
    await w.app.close();
  });

  it('needs a reason and at least one date', async () => {
    const w = await world();
    const headers = authHeader(w.app, w.managerId, 'legal_manager');
    const url = `/cases/${w.caseRow.id}/target-dates`;

    const noReason = await w.app.inject({ method: 'PATCH', url, headers, payload: { resolutionDueAt: inDays(30) } });
    const noDates = await w.app.inject({ method: 'PATCH', url, headers, payload: { reason: 'Because' } });

    expect(noReason.statusCode).toBe(400);
    expect(noDates.statusCode).toBe(400);
    await w.app.close();
  });

  it('rejects dates before the case existed, and an acknowledgement date after the resolution date', async () => {
    const w = await world();
    const headers = authHeader(w.app, w.managerId, 'legal_manager');
    const url = `/cases/${w.caseRow.id}/target-dates`;

    const tooEarly = await w.app.inject({ method: 'PATCH', url, headers, payload: { resolutionDueAt: inDays(-400), reason: 'Backdating' } });
    const crossed = await w.app.inject({ method: 'PATCH', url, headers, payload: { ackDueAt: inDays(60), resolutionDueAt: inDays(10), reason: 'Mixed up' } });

    expect(tooEarly.statusCode).toBe(400);
    expect(crossed.statusCode).toBe(400);
    const [unchanged] = await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'case.target_dates_changed'`);
    expect(unchanged.n).toBe(0);
    await w.app.close();
  });

  it('does not touch a closed case', async () => {
    const w = await world('Closed');

    const res = await w.app.inject({
      method: 'PATCH',
      url: `/cases/${w.caseRow.id}/target-dates`,
      headers: authHeader(w.app, w.managerId, 'legal_manager'),
      payload: { resolutionDueAt: inDays(30), reason: 'Too late' },
    });

    expect(res.statusCode).toBe(409);
    await w.app.close();
  });
});
