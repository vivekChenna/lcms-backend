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
});
