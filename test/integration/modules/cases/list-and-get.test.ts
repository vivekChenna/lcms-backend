import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';

describe('GET /cases and GET /cases/:id — visibility matrix', () => {
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

  it('admin sees all cases across departments', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const masterA = await seedCaseMasterData(ds);
    const masterB = await seedCaseMasterData(ds);
    const requesterA = await seedUserWithRole(ds, 'requester', { departmentId: masterA.departmentId, entityId: masterA.entityId });
    const requesterB = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    await seedCase(ds, { ...masterA, requesterId: requesterA });
    await seedCase(ds, { ...masterB, requesterId: requesterB });
    const adminId = await seedUserWithRole(ds, 'admin');
    const token = app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.json().total).toBe(2);
    await app.close();
  });

  it('legal_rep sees all cases read-only, including ones not assigned to them (AC-05)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId });
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.json().total).toBe(1);
    await app.close();
  });

  it('requester sees only their own department\'s cases (AC-04)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const masterA = await seedCaseMasterData(ds);
    const masterB = await seedCaseMasterData(ds);
    const requesterA = await seedUserWithRole(ds, 'requester', { departmentId: masterA.departmentId, entityId: masterA.entityId });
    const requesterB = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    await seedCase(ds, { ...masterA, requesterId: requesterA });
    await seedCase(ds, { ...masterB, requesterId: requesterB });
    const token = app.signAccessToken({ id: requesterA, role: 'requester', departmentId: masterA.departmentId, entityId: masterA.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].departmentId).toBe(masterA.departmentId);
    await app.close();
  });

  it('viewer sees all cases read-only (AC-07)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const masterA = await seedCaseMasterData(ds);
    const masterB = await seedCaseMasterData(ds);
    const requesterA = await seedUserWithRole(ds, 'requester', { departmentId: masterA.departmentId, entityId: masterA.entityId });
    const requesterB = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    await seedCase(ds, { ...masterA, requesterId: requesterA });
    await seedCase(ds, { ...masterB, requesterId: requesterB });
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const token = app.signAccessToken({ id: viewerId, role: 'viewer', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.json().total).toBe(2);
    await app.close();
  });

  it('returns 404 when a requester fetches a case outside their department', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const masterA = await seedCaseMasterData(ds);
    const masterB = await seedCaseMasterData(ds);
    const requesterA = await seedUserWithRole(ds, 'requester', { departmentId: masterA.departmentId, entityId: masterA.entityId });
    const requesterB = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    const caseB = await seedCase(ds, { ...masterB, requesterId: requesterB });
    const token = app.signAccessToken({ id: requesterA, role: 'requester', departmentId: masterA.departmentId, entityId: masterA.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseB.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('filters by status and slaState', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    await seedCase(ds, {
      ...master,
      requesterId,
      status: 'In Progress',
      submittedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10),
      slaResolutionHours: 1,
    });
    const adminId = await seedUserWithRole(ds, 'admin');
    const token = app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/cases?slaState=breached', headers: { authorization: `Bearer ${token}` } });
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].status).toBe('In Progress');
    await app.close();
  });
});
