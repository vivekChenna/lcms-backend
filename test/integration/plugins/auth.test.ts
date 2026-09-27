import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';

describe('authenticate preHandler', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('rejects a request with no Authorization header', async () => {
    const app = buildTestApp(ds);
    app.get('/protected', { preHandler: (request, reply) => app.authenticate(request, reply) }, async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('accepts a request with a valid access token and populates request.user', async () => {
    const app = buildTestApp(ds);
    app.get(
      '/protected',
      { preHandler: (request, reply) => app.authenticate(request, reply) },
      async (request) => ({ userId: request.user.id }),
    );
    await app.ready();

    const token = app.signAccessToken({
      id: 'user-1',
      role: 'admin',
      departmentId: null,
      entityId: null,
      businessUnitId: null,
    });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'user-1' });

    await app.close();
  });
});
