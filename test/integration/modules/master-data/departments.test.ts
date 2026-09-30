import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';

describe('/departments', () => {
  let ds: DataSource;
  let adminId: string;

  function adminToken(app: ReturnType<typeof buildTestApp>) {
    return app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
  }

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
    adminId = await seedUserWithRole(ds, 'admin');
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM departments');
  });

  it('creates and lists a department', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const create = await app.inject({
      method: 'POST',
      url: '/departments',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Human Resources' },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/departments', headers: { authorization: `Bearer ${token}` } });
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('rejects a duplicate department name', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Finance' } });
    const dup = await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Finance' } });

    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it('rejects renaming a department to a name that already exists (PATCH has no pre-check — relies on the central 23505 mapper)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Finance' } });
    const create = await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Operations' } });
    const id = create.json().id;

    const rename = await app.inject({
      method: 'PATCH',
      url: `/departments/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Finance' },
    });

    expect(rename.statusCode).toBe(409);
    await app.close();
  });

  it('soft-deactivates via PATCH isActive:false instead of deleting (DM-09 immediate effect, no hard delete)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const create = await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Legal' } });
    const id = create.json().id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/departments/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isActive: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().isActive).toBe(false);

    const row = await ds.query(`SELECT id FROM departments WHERE id = $1`, [id]);
    expect(row).toHaveLength(1);

    await app.close();
  });

  it('rejects create/update from a non-admin role but still allows reads (UI-18)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const requesterId = await seedUserWithRole(ds, 'requester');
    const requesterToken = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const createAttempt = await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${requesterToken}` }, payload: { name: 'X' } });
    expect(createAttempt.statusCode).toBe(403);

    const readAttempt = await app.inject({ method: 'GET', url: '/departments', headers: { authorization: `Bearer ${requesterToken}` } });
    expect(readAttempt.statusCode).toBe(200);

    await app.close();
  });
});
