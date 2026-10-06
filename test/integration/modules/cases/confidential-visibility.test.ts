// test/integration/modules/cases/confidential-visibility.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { seedComment } from '../../helpers/seed-comment';
import { authHeader } from '../../helpers/auth-header';

describe('confidential case visibility', () => {
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

  // C = confidential case, N = ordinary case, both in department D submitted by `submitter`.
  async function world() {
    const master = await seedCaseMasterData(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const dept = { departmentId: master.departmentId, entityId: master.entityId };
    const submitter = await seedUserWithRole(ds, 'requester', dept);
    const colleague = await seedUserWithRole(ds, 'requester', dept);
    const responder = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    const admin = await seedUserWithRole(ds, 'admin');
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const rep = await seedUserWithRole(ds, 'legal_rep');
    const viewer = await seedUserWithRole(ds, 'viewer');
    const confidential = await seedCase(ds, { ...master, requesterId: submitter, referenceNumber: 'CONF-1', isConfidential: true, status: 'In Progress', assignedLegalRepId: rep });
    const ordinary = await seedCase(ds, { ...master, requesterId: submitter, referenceNumber: 'PLAIN-1', status: 'In Progress', assignedLegalRepId: rep });
    await seedInformationRequest(ds, { caseId: confidential.id, raisedById: rep, responderId: responder });
    await seedComment(ds, { caseId: confidential.id, authorId: rep, body: 'legal chatter' });
    return { master, submitter, colleague, responder, admin, manager, rep, viewer, confidential, ordinary };
  }

  const seesConfidential = ['admin', 'manager', 'rep', 'submitter', 'responder'] as const;
  const hidden = ['colleague', 'viewer'] as const;
  const roleOf = { admin: 'admin', manager: 'legal_manager', rep: 'legal_rep', submitter: 'requester', responder: 'requester', colleague: 'requester', viewer: 'viewer' } as const;

  it.each([...seesConfidential])('%s sees the confidential case in the list, by id and by search', async (who) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w[who], roleOf[who]);

    const list = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers });
    const detail = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}`, headers });
    const search = await app.inject({ method: 'GET', url: '/cases?search=CONF-1', headers });

    expect(list.json().items.map((i: { referenceNumber: string }) => i.referenceNumber)).toContain('CONF-1');
    expect(detail.statusCode).toBe(200);
    expect(search.json().total).toBe(1);
    await app.close();
  });

  it.each([...hidden])('%s never learns the confidential case exists (list, detail, search, sub-resources)', async (who) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w[who], roleOf[who]);

    const list = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers });
    const detail = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}`, headers });
    const search = await app.inject({ method: 'GET', url: '/cases?search=CONF-1', headers });
    const comments = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/comments`, headers });
    const documents = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/documents`, headers });
    const requests = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/information-requests`, headers });

    expect(list.json().items.map((i: { referenceNumber: string }) => i.referenceNumber)).not.toContain('CONF-1');
    expect(list.json().items.map((i: { referenceNumber: string }) => i.referenceNumber)).toContain('PLAIN-1');
    expect(detail.statusCode).toBe(404);
    expect(search.json().total).toBe(0);
    expect(comments.statusCode).toBe(404);
    expect(documents.statusCode).toBe(404);
    expect(requests.statusCode).toBe(404);
    await app.close();
  });

  it('the hidden case is excluded from dashboard counts and from the dashboard panels for a viewer and a colleague', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const viewer = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.viewer, 'viewer') });
    const colleague = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.colleague, 'requester') });
    const manager = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.manager, 'legal_manager') });

    expect(viewer.json().tiles.total).toBe(1);
    expect(colleague.json().tiles.total).toBe(1);
    expect(manager.json().tiles.total).toBe(2);
    await app.close();
  });

  it('a viewer\'s report figures and exports exclude the confidential case', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.viewer, 'viewer');

    const ageing = await app.inject({ method: 'GET', url: '/reports/ageing', headers });
    const volume = await app.inject({ method: 'GET', url: '/reports/volume-by-category', headers });
    const caseExport = await app.inject({ method: 'GET', url: '/cases/export', headers });
    const managerExport = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, w.manager, 'legal_manager') });

    const openTotal = ageing.json().reduce((sum: number, row: { count: number }) => sum + row.count, 0);
    const volumeTotal = volume.json().reduce((sum: number, row: { count: number }) => sum + row.count, 0);
    expect(openTotal).toBe(1);
    expect(volumeTotal).toBe(1);
    expect(caseExport.body).not.toContain('CONF-1');
    expect(caseExport.body).toContain('PLAIN-1');
    expect(managerExport.body).toContain('CONF-1');
    await app.close();
  });

  it('the information-request responder sees the case and its information requests but not other confidential cases', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const other = await seedCase(ds, { ...w.master, requesterId: w.submitter, referenceNumber: 'CONF-2', isConfidential: true });
    const headers = authHeader(app, w.responder, 'requester');

    const requests = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/information-requests`, headers });
    const otherDetail = await app.inject({ method: 'GET', url: `/cases/${other.id}`, headers });

    expect(requests.statusCode).toBe(200);
    expect(otherDetail.statusCode).toBe(404);
    await app.close();
  });

  it('a requester always sees a non-confidential case they submitted themselves, even for another department', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const elsewhere = await seedCaseMasterData(ds);
    const mine = await seedCase(ds, { ...elsewhere, requesterId: w.submitter, referenceNumber: 'MINE-OTHERDEPT' });

    const res = await app.inject({ method: 'GET', url: `/cases/${mine.id}`, headers: authHeader(app, w.submitter, 'requester') });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('non-confidential behaviour is unchanged: colleagues see it, viewers see it, other departments do not', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const stranger = await seedCaseMasterData(ds);
    const strangerRequester = await seedUserWithRole(ds, 'requester', { departmentId: stranger.departmentId, entityId: stranger.entityId });

    const colleague = await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers: authHeader(app, w.colleague, 'requester') });
    const viewer = await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers: authHeader(app, w.viewer, 'viewer') });
    const outsider = await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers: authHeader(app, strangerRequester, 'requester') });

    expect(colleague.statusCode).toBe(200);
    expect(viewer.statusCode).toBe(200);
    expect(outsider.statusCode).toBe(404);
    await app.close();
  });

  it('flipping the flag takes effect immediately for a colleague', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.colleague, 'requester');
    expect((await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers })).statusCode).toBe(200);

    await ds.query(`UPDATE cases SET "isConfidential" = true WHERE id = $1`, [w.ordinary.id]);

    expect((await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers })).statusCode).toBe(404);
    await app.close();
  });

  it('editing a hidden confidential case answers 404, not 403, so the attempt does not confirm it exists', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const submitted = await seedCase(ds, { ...w.master, requesterId: w.submitter, referenceNumber: 'CONF-SUB', isConfidential: true });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${submitted.id}`,
      headers: authHeader(app, w.colleague, 'requester'),
      payload: { title: 'A probing title change' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
