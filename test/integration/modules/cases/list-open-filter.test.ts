import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('GET /cases open filter', () => {
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

  async function seedMix() {
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const repId = await seedUserWithRole(ds, 'legal_rep');
    for (const status of ['Submitted', 'Assigned', 'In Progress', 'Waiting on Input', 'Closed'] as const) {
      await seedCase(ds, { ...master, requesterId, status, assignedLegalRepId: status === 'Submitted' ? null : repId });
    }
    return { managerId };
  }

  it('open=true returns every case that is not Closed', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();

    const res = await app.inject({ method: 'GET', url: '/cases?open=true&pageSize=100', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(4);
    expect(res.json().items.map((item: { status: string }) => item.status)).not.toContain('Closed');
    await app.close();
  });

  it('omitting open still returns every case', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();

    const res = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.json().total).toBe(5);
    await app.close();
  });

  it('open combines with other filters and with the requester scope', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();
    const otherMaster = await seedCaseMasterData(ds);
    const otherRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedCase(ds, { ...otherMaster, requesterId: otherRequesterId, status: 'Submitted' });

    const combined = await app.inject({ method: 'GET', url: '/cases?open=true&status=Assigned', headers: authHeader(app, managerId, 'legal_manager') });
    const scoped = await app.inject({ method: 'GET', url: '/cases?open=true', headers: authHeader(app, otherRequesterId, 'requester') });

    expect(combined.json().total).toBe(1);
    expect(scoped.json().total).toBe(1);
    await app.close();
  });

  it('rejects an invalid open value with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();

    const res = await app.inject({ method: 'GET', url: '/cases?open=maybe', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
