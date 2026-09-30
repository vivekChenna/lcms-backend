import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';

describe('/docs (OpenAPI)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('serves the Swagger UI at /docs', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('generates an OpenAPI document covering every registered route, including ones added directly on the app instance', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();

    // A representative route from every module, plus the one route (/health)
    // that's registered directly on the top-level app instance rather than
    // through app.register() — the case that previously went missing from
    // the spec because it was added to the router before the swagger
    // plugin's onRoute hook existed.
    for (const path of ['/health', '/auth/login', '/users', '/departments', '/entities', '/audit']) {
      expect(spec.paths[path], `expected ${path} in the generated spec`).toBeDefined();
    }

    // An authenticated route must declare the bearer security requirement,
    // and the scheme itself must be defined so "Authorize" in the UI works.
    expect(spec.paths['/users'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });

    // Login is public — no access token exists yet at that point.
    expect(spec.paths['/auth/login'].post.security ?? []).toEqual([]);

    await app.close();
  });
});
