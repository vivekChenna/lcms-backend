import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';

describe('error handler', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('passes a non-AppError 4xx through as its real status instead of masking it as 500 (malformed JSON body)', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).not.toBe('INTERNAL_ERROR');

    await app.close();
  });

  it('returns the standard {error:{code,message}} shape for an unknown route (404)', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/this-route-does-not-exist' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });

    await app.close();
  });
});
