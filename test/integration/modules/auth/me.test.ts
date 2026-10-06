// test/integration/modules/auth/me.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('GET /auth/me and the login profile', () => {
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

  const nameOf = async (table: string, id: string) => (await ds.query(`SELECT name FROM ${table} WHERE id = $1`, [id]))[0].name as string;

  it('returns the full profile with organisation names for every role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    for (const role of ['admin', 'legal_manager', 'legal_rep', 'requester', 'viewer'] as const) {
      const userId = await seedUserWithRole(ds, role, { fullName: `Name ${role}`, departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
      await ds.query(`UPDATE users SET designation = $1 WHERE id = $2`, [`Designation ${role}`, userId]);

      const res = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader(app, userId, role) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: userId,
        fullName: `Name ${role}`,
        email: expect.stringContaining('@'),
        designation: `Designation ${role}`,
        role,
        departmentId: master.departmentId,
        departmentName: await nameOf('departments', master.departmentId),
        entityId: master.entityId,
        entityName: await nameOf('entities', master.entityId),
        businessUnitId: master.businessUnitId,
        businessUnitName: await nameOf('business_units', master.businessUnitId),
      });
    }
    await app.close();
  });

  it('uses nulls for an organisation the user has none of', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'viewer');

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader(app, userId, 'viewer') });

    expect(res.json()).toMatchObject({ designation: null, departmentId: null, departmentName: null, entityName: null, businessUnitName: null });
    await app.close();
  });

  it('login and refresh return the same profile shape in user', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const userId = await seedUserWithRole(ds, 'requester', { email: 'p@algihaz.local', fullName: 'Pat Profile', departmentId: master.departmentId, entityId: master.entityId });

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'p@algihaz.local', password: 'Password123!' } });
    const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: login.json().refreshToken } });

    for (const body of [login.json(), refresh.json()]) {
      expect(body.user).toMatchObject({ id: userId, fullName: 'Pat Profile', email: 'p@algihaz.local', role: 'requester', departmentName: await nameOf('departments', master.departmentId) });
    }
    await app.close();
  });

  it('requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/auth/me' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
