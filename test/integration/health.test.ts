import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from './helpers/test-data-source';
import { buildTestApp } from './helpers/build-test-app';

describe('GET /health', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('returns ok status', async () => {
    const app = buildTestApp(ds);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
