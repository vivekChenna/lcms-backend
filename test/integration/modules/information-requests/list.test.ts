import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { resetDatabase } from '../../helpers/reset-db';

describe('GET /cases/:id/information-requests', () => {
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
  }

  it('lists all requests for a case the caller can see, newest first', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    const first = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'Second' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/information-requests`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0].id).toBe(second.id);
    expect(res.json()[1].id).toBe(first.id);
    await app.close();
  });

  it('returns 404 for a case the caller cannot see (reuses case-core visibility)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const masterA = await seedCaseMasterData(ds);
    const masterB = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    const requesterB = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    const caseRow = await seedCase(ds, { ...masterB, requesterId: requesterB, status: 'In Progress', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: masterA.departmentId, entityId: masterA.entityId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: masterA.departmentId, entityId: masterA.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/information-requests`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
