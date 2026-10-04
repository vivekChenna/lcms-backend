import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';

describe('PATCH /cases/:id', () => {
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
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('lets the submitter edit their own Submitted case', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, title: 'Original title' });
    const token = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: master.departmentId, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Updated title' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Updated title');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.updated'`);
    expect(auditRows).toHaveLength(1);
    await app.close();
  });

  it('rejects editing once the case is Assigned', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });
    const token = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: master.departmentId, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'New title' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects editing by someone other than the submitter or admin', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const otherRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId });
    const token = app.signAccessToken({ id: otherRequesterId, role: 'requester', departmentId: master.departmentId, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'New title' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets admin edit any Submitted case', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId });
    const adminId = await seedUserWithRole(ds, 'admin');
    const token = app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Admin-corrected title' },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a requester editing their Internal case to a non-Internal category (VC-03)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const [internalCategory] = await ds.query(`SELECT id FROM case_categories WHERE name = 'Internal'`);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, categoryId: internalCategory.id, requesterId });
    const token = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: master.departmentId, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { categoryId: master.categoryId },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects changing categoryId without caseTypeId when the existing caseType does not belong to the new category (VC-04)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const adminId = await seedUserWithRole(ds, 'admin');
    // caseRow's caseTypeId belongs to master.categoryId; PATCHing categoryId
    // to otherMaster.categoryId (without touching caseTypeId) must now be
    // rejected because the existing caseType no longer belongs to it. Acting
    // as admin (not the requester) isolates this from the separate VC-03
    // (Internal-only) check covered by the test above.
    const caseRow = await seedCase(ds, { ...master, requesterId });
    const token = app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { categoryId: otherMaster.categoryId },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
