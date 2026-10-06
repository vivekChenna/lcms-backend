// test/integration/modules/audit/case-audit.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { authHeader } from '../../helpers/auth-header';

describe('GET /cases/:id/audit', () => {
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

  async function world() {
    const master = await seedCaseMasterData(ds);
    const dept = { departmentId: master.departmentId, entityId: master.entityId };
    const requester = await seedUserWithRole(ds, 'requester', dept);
    const rep = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Lina Lawyer' });
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const admin = await seedUserWithRole(ds, 'admin');
    const viewer = await seedUserWithRole(ds, 'viewer');
    const caseRow = await seedCase(ds, { ...master, requesterId: requester, status: 'In Progress', assignedLegalRepId: rep });
    const at = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();
    const log = async (action: string, actor: string, day: number, afterValue?: Record<string, unknown>) => {
      await logAuditEvent(ds, { actorId: actor, caseId: caseRow.id, action, afterValue });
      await ds.query(`UPDATE audit_log SET "createdAt" = $1 WHERE id = (SELECT id FROM audit_log WHERE "caseId" = $2 AND action = $3 ORDER BY "createdAt" DESC LIMIT 1)`, [at(day), caseRow.id, action]);
    };
    await log('case.submitted', requester, 1);
    await log('case.rejected', rep, 2, { reason: 'Conflict of interest' });
    await log('comment.created', rep, 3, { isInternal: true, body: 'INTERNAL LEGAL NOTE' });
    await log('comment.edited', rep, 4, { isInternal: true, body: 'INTERNAL EDIT' });
    await log('comment.deleted', rep, 5, { isInternal: true });
    await log('info_request.raised', rep, 6, { subject: 'Need info' });
    await ds.query(`INSERT INTO audit_log (id, "caseId", "actorId", action, "beforeValue", "afterValue") VALUES (gen_random_uuid(), $1, $2, 'comment.edited', $3, $4)`, [caseRow.id, rep, JSON.stringify({ isInternal: true, body: 'OLD INTERNAL' }), JSON.stringify({ isInternal: false, body: 'made public' })]);
    const publicEvent = await ds.query(`INSERT INTO audit_log (id, "caseId", "actorId", action, "afterValue") VALUES (gen_random_uuid(), $1, $2, 'comment.created', $3) RETURNING id`, [caseRow.id, requester, JSON.stringify({ isInternal: false, body: 'Visible comment' })]);
    return { caseRow, requester, rep, manager, admin, viewer, publicEvent: publicEvent[0].id as string };
  }

  const actionsOf = (res: { json: () => { items: Array<{ action: string }> } }) => res.json().items.map((item) => item.action);

  it.each([['admin', 'admin'], ['manager', 'legal_manager'], ['rep', 'legal_rep']] as const)('%s sees every row of the case, newest first, with names', async (who, role) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?pageSize=100`, headers: authHeader(app, w[who], role) });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(8);
    expect(actionsOf(res)).toContain('case.rejected');
    expect(JSON.stringify(res.json())).toContain('INTERNAL LEGAL NOTE');
    const rejected = res.json().items.find((item: { action: string }) => item.action === 'case.rejected');
    expect(rejected).toMatchObject({ actorName: 'Lina Lawyer', actorRole: 'legal_rep', caseReference: w.caseRow.referenceNumber });
    const times = res.json().items.map((item: { createdAt: string }) => item.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    await app.close();
  });

  it.each([['requester', 'requester'], ['viewer', 'viewer']] as const)('%s never sees internal comment events or the rejection reason', async (who, role) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?pageSize=100`, headers: authHeader(app, w[who], role) });

    expect(res.statusCode).toBe(200);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain('INTERNAL LEGAL NOTE');
    expect(text).not.toContain('INTERNAL EDIT');
    expect(text).not.toContain('OLD INTERNAL');
    expect(text).not.toContain('Conflict of interest');
    expect(actionsOf(res)).not.toContain('case.rejected');
    expect(actionsOf(res)).toContain('case.submitted');
    expect(actionsOf(res)).toContain('info_request.raised');
    expect(res.json().items.some((item: { id: string }) => item.id === w.publicEvent)).toBe(true);
    expect(res.json().total).toBe(res.json().items.length);
    await app.close();
  });

  it('paginates and filters by date', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.manager, 'legal_manager');

    const page = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?page=2&pageSize=3`, headers });
    const window = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?createdFrom=2026-01-02T00:00:00Z&createdTo=2026-01-03T23:59:59Z`, headers });
    const reversed = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?createdFrom=2026-02-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z`, headers });

    expect(page.json()).toMatchObject({ total: 8, page: 2, pageSize: 3 });
    expect(page.json().items).toHaveLength(3);
    expect(actionsOf(window).sort()).toEqual(['case.rejected', 'comment.created']);
    expect(reversed.statusCode).toBe(400);
    await app.close();
  });

  it('answers 404 when the case is not visible to the caller (confidential, other department)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    await ds.query(`UPDATE cases SET "isConfidential" = true WHERE id = $1`, [w.caseRow.id]);
    const colleague = await seedUserWithRole(ds, 'requester', { departmentId: w.caseRow.departmentId, entityId: w.caseRow.entityId });
    const stranger = await seedCaseMasterData(ds);
    const outsider = await seedUserWithRole(ds, 'requester', { departmentId: stranger.departmentId, entityId: stranger.entityId });

    for (const [userId, role] of [[w.viewer, 'viewer'], [colleague, 'requester'], [outsider, 'requester']] as const) {
      const res = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit`, headers: authHeader(app, userId, role) });
      expect(res.statusCode).toBe(404);
    }
    const unknown = await app.inject({ method: 'GET', url: '/cases/6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e/audit', headers: authHeader(app, w.manager, 'legal_manager') });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it('requires authentication, validates the id and writes no audit entry for the read', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const [{ count: before }] = await ds.query(`SELECT COUNT(*)::int AS count FROM audit_log`);

    const anonymous = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit` });
    const badId = await app.inject({ method: 'GET', url: '/cases/not-a-uuid/audit', headers: authHeader(app, w.manager, 'legal_manager') });
    await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit`, headers: authHeader(app, w.manager, 'legal_manager') });

    const [{ count: after }] = await ds.query(`SELECT COUNT(*)::int AS count FROM audit_log`);
    expect(anonymous.statusCode).toBe(401);
    expect(badId.statusCode).toBe(400);
    expect(after).toBe(before);
    await app.close();
  });

  it('hides payloads written by the real comment and rejection flows from the requester', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requester = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const rep = await seedUserWithRole(ds, 'legal_rep');
    const caseRow = await seedCase(ds, { ...master, requesterId: requester, status: 'Assigned', assignedLegalRepId: rep });
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const repHeaders = authHeader(app, rep, 'legal_rep');
    const managerHeaders = authHeader(app, manager, 'legal_manager');

    const internal = await app.inject({ method: 'POST', url: `/cases/${caseRow.id}/comments`, headers: managerHeaders, payload: { body: 'REAL INTERNAL NOTE', isInternal: true } });
    expect(internal.statusCode).toBe(201);
    expect((await app.inject({ method: 'PATCH', url: `/comments/${internal.json().id}`, headers: managerHeaders, payload: { body: 'REAL INTERNAL EDIT' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/comments/${internal.json().id}`, headers: managerHeaders })).statusCode).toBeLessThan(300);
    const reject = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/reject`, headers: repHeaders, payload: { reason: 'REAL REJECTION REASON' } });
    expect(reject.statusCode).toBe(200);

    const legal = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/audit`, headers: authHeader(app, rep, 'legal_rep') });
    expect(actionsOf(legal).sort()).toEqual(['case.rejected', 'comment.created', 'comment.deleted', 'comment.edited']);

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/audit`, headers: authHeader(app, requester, 'requester') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], total: 0 });
    const text = JSON.stringify(res.json());
    expect(text).not.toContain('REAL INTERNAL');
    expect(text).not.toContain('REAL REJECTION REASON');
    await app.close();
  });
});
