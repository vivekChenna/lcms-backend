import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';

const FRONTEND_PATHS = [
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/me',
  '/auth/change-password',
  '/cases',
  '/cases/{id}',
  '/cases/{id}/audit',
  '/cases/{id}/comments',
  '/cases/{id}/documents',
  '/cases/{id}/information-requests',
  '/dashboard',
  '/reports/ageing',
  '/audit',
  '/notifications',
  '/notifications/read-all',
  '/users',
  '/routing-rules',
  '/departments',
  '/case-categories',
  '/closure-outcomes',
  '/entities',
  '/business-units',
  '/case-types',
];

describe('GET /docs/json', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('documents both bearer and cookie authentication and every path the frontend uses', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(doc.components.securitySchemes.cookieAuth).toEqual({ type: 'apiKey', in: 'cookie', name: 'lcms_access' });

    const documented = Object.keys(doc.paths);
    expect(FRONTEND_PATHS.filter((p) => !documented.includes(p))).toEqual([]);

    await app.close();
  });
});
