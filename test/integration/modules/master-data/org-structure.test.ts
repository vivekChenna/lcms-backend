import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('/entities, /business-units', () => {
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
    await ds.destroy();
  });

  it('seeds the 10 required entities (DM-03)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({ method: 'GET', url: '/entities', headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toHaveLength(10);

    await app.close();
  });

  it('creates a business unit under a valid entity', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const [entity] = (await app.inject({ method: 'GET', url: '/entities', headers: { authorization: `Bearer ${token}` } })).json();

    const res = await app.inject({
      method: 'POST',
      url: '/business-units',
      headers: { authorization: `Bearer ${token}` },
      payload: { entityId: entity.id, name: 'Operations' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().entityId).toBe(entity.id);

    await app.close();
  });

  it('rejects a business unit referencing an unknown entityId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/business-units',
      headers: { authorization: `Bearer ${token}` },
      payload: { entityId: '00000000-0000-0000-0000-000000000000', name: 'Ghost BU' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists business units filtered by entityId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const entities = (await app.inject({ method: 'GET', url: '/entities', headers: { authorization: `Bearer ${token}` } })).json();
    const [first, second] = entities;

    await app.inject({ method: 'POST', url: '/business-units', headers: { authorization: `Bearer ${token}` }, payload: { entityId: first.id, name: 'Unit A' } });
    await app.inject({ method: 'POST', url: '/business-units', headers: { authorization: `Bearer ${token}` }, payload: { entityId: second.id, name: 'Unit B' } });

    const res = await app.inject({ method: 'GET', url: `/business-units?entityId=${first.id}`, headers: { authorization: `Bearer ${token}` } });
    const names = res.json().map((bu: { name: string }) => bu.name);
    expect(names).toContain('Unit A');
    expect(names).not.toContain('Unit B');

    await app.close();
  });
});
