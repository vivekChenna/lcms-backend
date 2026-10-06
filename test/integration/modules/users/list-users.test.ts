import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';

describe('GET /users, GET /users/:id', () => {
  let ds: DataSource;
  let adminId: string;

  function adminToken(app: ReturnType<typeof buildTestApp>) {
    return app.signAccessToken({ id: adminId, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
  }

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
    adminId = await seedUserWithRole(ds, 'admin');
  });

  it('lists users with their role and a paginated envelope', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'jane@algihaz.local', password: 'Password123!' },
    });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 2, not 1: the seeded admin (needed so its own token resolves through
    // the now fail-closed authenticate) is itself a row in the same table.
    expect(body.total).toBe(2);
    expect(body.items[0].role).toBe('requester');

    await app.close();
  });

  it('allows legal_manager to list users (visibility without edit, PR-22)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const legalManagerId = await seedUserWithRole(ds, 'legal_manager');
    const managerToken = app.signAccessToken({ id: legalManagerId, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${managerToken}` } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('returns 404 for an unknown user id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'GET',
      url: '/users/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects list access for a requester role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const requesterId = await seedUserWithRole(ds, 'requester');
    const token = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  describe('filters', () => {
    async function seedFilterUsers() {
      await seedUserWithRole(ds, 'legal_rep', { email: 'rep.active@algihaz.local', fullName: 'Active Rep' });
      await seedUserWithRole(ds, 'legal_rep', { email: 'rep.inactive@algihaz.local', fullName: 'Inactive Rep', isActive: false });
      await seedUserWithRole(ds, 'requester', { email: 'someone@algihaz.local', fullName: 'Some Requester' });
    }

    async function list(query: string) {
      const app = buildTestApp(ds);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: `/users${query}`, headers: { authorization: `Bearer ${adminToken(app)}` } });
      await app.close();
      return res;
    }

    it('filters by role and reflects the filter in total', async () => {
      await seedFilterUsers();
      const body = (await list('?role=legal_rep')).json();
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(2);
      expect(body.items.every((u: { role: string }) => u.role === 'legal_rep')).toBe(true);
    });

    it('filters by role and isActive', async () => {
      await seedFilterUsers();
      const active = (await list('?role=legal_rep&isActive=true')).json();
      expect(active.total).toBe(1);
      expect(active.items[0].email).toBe('rep.active@algihaz.local');
      const inactive = (await list('?isActive=false')).json();
      expect(inactive.total).toBe(1);
      expect(inactive.items[0].email).toBe('rep.inactive@algihaz.local');
    });

    it('searches fullName or email case-insensitively', async () => {
      await seedFilterUsers();
      const byEmail = (await list('?search=SOMEONE@')).json();
      expect(byEmail.total).toBe(1);
      expect(byEmail.items[0].email).toBe('someone@algihaz.local');
      const byName = (await list('?search=inactive%20rep')).json();
      expect(byName.total).toBe(1);
      expect(byName.items[0].email).toBe('rep.inactive@algihaz.local');
    });

    it('treats % and _ in search as literal characters', async () => {
      await seedFilterUsers();
      expect((await list('?search=%25')).json().total).toBe(0);
      expect((await list('?search=rep_active')).json().total).toBe(0);
    });

    it('paginates the filtered set', async () => {
      await seedFilterUsers();
      const body = (await list('?role=legal_rep&pageSize=1&page=2')).json();
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(1);
    });

    it('pages are disjoint and cover the set even when createdAt ties', async () => {
      for (let i = 0; i < 5; i++) {
        await seedUserWithRole(ds, 'legal_rep', { email: `tie${i}@algihaz.local`, fullName: `Tie ${i}` });
      }
      await ds.query(`UPDATE users SET "createdAt" = '2026-01-01T00:00:00Z'`);

      const ids: string[] = [];
      for (const page of [1, 2, 3]) {
        const body = (await list(`?role=legal_rep&pageSize=2&page=${page}`)).json();
        expect(body.total).toBe(5);
        ids.push(...body.items.map((u: { id: string }) => u.id));
      }
      expect(new Set(ids).size).toBe(5);
      expect(ids).toEqual([...ids].sort().reverse());
    });

    it('rejects an invalid role, isActive or blank search with 400', async () => {
      expect((await list('?role=wizard')).statusCode).toBe(400);
      expect((await list('?isActive=maybe')).statusCode).toBe(400);
      expect((await list('?search=%20%20')).statusCode).toBe(400);
    });

    it('still forbids a legal_rep caller', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const repId = await seedUserWithRole(ds, 'legal_rep');
      const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });
      const res = await app.inject({ method: 'GET', url: '/users?role=legal_rep', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
