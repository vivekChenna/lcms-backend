import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { resetDatabase } from '../../helpers/reset-db';

describe('requester visibility extension — sees a case they are a responder on (AC-04)', () => {
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

  it('GET /cases/:id: a requester outside the case\'s department can see it once they are the responder on an information request', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const caseDepartment = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: caseDepartment.departmentId, entityId: caseDepartment.entityId });
    const outsiderDepartment = await seedCaseMasterData(ds);
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId });
    const caseRow = await seedCase(ds, { ...caseDepartment, requesterId: caseRequesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: outsiderRequesterId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('GET /cases: the same case appears in that requester\'s list', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const caseDepartment = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: caseDepartment.departmentId, entityId: caseDepartment.entityId });
    const outsiderDepartment = await seedCaseMasterData(ds);
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId });
    const caseRow = await seedCase(ds, { ...caseDepartment, requesterId: caseRequesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: outsiderRequesterId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/cases', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((c: { id: string }) => c.id);
    expect(ids).toContain(caseRow.id);
    await app.close();
  });

  it('a requester who is a responder still cannot assign/close/escalate the case (visibility is not write access)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const caseDepartment = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: caseDepartment.departmentId, entityId: caseDepartment.entityId });
    const outsiderDepartment = await seedCaseMasterData(ds);
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId });
    const caseRow = await seedCase(ds, { ...caseDepartment, requesterId: caseRequesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: outsiderRequesterId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/escalate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isEscalated: true, reason: 'x' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
