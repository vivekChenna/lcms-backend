import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';

describe('/case-categories, /closure-outcomes', () => {
  let ds: DataSource;
  let adminId: string;
  let viewerId: string;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
    adminId = await seedUserWithRole(ds, 'admin');
    viewerId = await seedUserWithRole(ds, 'viewer');
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('lists the four seeded case categories (DM-01)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: viewerId, role: 'viewer', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/case-categories', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const names = res.json().map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Baladi Violation', 'HR Termination', 'Internal', 'Najiz']));

    await app.close();
  });

  it('admin can add a new closure outcome (PR-29, extensible master data)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/closure-outcomes',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Settled Out of Court' },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
