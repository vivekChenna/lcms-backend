import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('/case-types', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('creates a case type under a valid category with SLA hours', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const [category] = (await app.inject({ method: 'GET', url: '/case-categories', headers: { authorization: `Bearer ${token}` } })).json();

    const res = await app.inject({
      method: 'POST',
      url: '/case-types',
      headers: { authorization: `Bearer ${token}` },
      payload: { categoryId: category.id, name: 'Contract Dispute', slaAckHours: 24, slaResolutionHours: 240 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().slaResolutionHours).toBe(240);

    await app.close();
  });

  it('rejects a case type with an unknown categoryId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/case-types',
      headers: { authorization: `Bearer ${token}` },
      payload: { categoryId: '00000000-0000-0000-0000-000000000000', name: 'X', slaAckHours: 1, slaResolutionHours: 1 },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects renaming a case type to a name that collides within the same category (composite unique + central 23505 mapper)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const [category] = (await app.inject({ method: 'GET', url: '/case-categories', headers: { authorization: `Bearer ${token}` } })).json();

    await app.inject({ method: 'POST', url: '/case-types', headers: { authorization: `Bearer ${token}` }, payload: { categoryId: category.id, name: 'Existing Type', slaAckHours: 24, slaResolutionHours: 100 } });
    const create = await app.inject({ method: 'POST', url: '/case-types', headers: { authorization: `Bearer ${token}` }, payload: { categoryId: category.id, name: 'Renamable Type', slaAckHours: 24, slaResolutionHours: 100 } });
    const id = create.json().id;

    const rename = await app.inject({
      method: 'PATCH',
      url: `/case-types/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Existing Type' },
    });

    expect(rename.statusCode).toBe(409);
    await app.close();
  });

  it('lists case types filtered by categoryId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const categories = (await app.inject({ method: 'GET', url: '/case-categories', headers: { authorization: `Bearer ${token}` } })).json();
    const najiz = categories.find((c: { name: string }) => c.name === 'Najiz');
    const internal = categories.find((c: { name: string }) => c.name === 'Internal');

    await app.inject({ method: 'POST', url: '/case-types', headers: { authorization: `Bearer ${token}` }, payload: { categoryId: najiz.id, name: 'Najiz Type A', slaAckHours: 24, slaResolutionHours: 100 } });
    await app.inject({ method: 'POST', url: '/case-types', headers: { authorization: `Bearer ${token}` }, payload: { categoryId: internal.id, name: 'Internal Type A', slaAckHours: 24, slaResolutionHours: 100 } });

    const res = await app.inject({ method: 'GET', url: `/case-types?categoryId=${najiz.id}`, headers: { authorization: `Bearer ${token}` } });
    const names = res.json().map((t: { name: string }) => t.name);
    expect(names).toEqual(['Najiz Type A']);

    await app.close();
  });
});
