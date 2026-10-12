import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { authHeader } from '../../helpers/auth-header';
import { seedUserWithRole } from '../../helpers/seed-user';
import { resetDatabase } from '../../helpers/reset-db';

describe('GET /case-holders', () => {
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

  it('lists the active legal reps and managers for any signed-in role, and nobody else', async () => {
    await resetDatabase(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'A Rep' });
    const managerId = await seedUserWithRole(ds, 'legal_manager', { fullName: 'B Manager' });
    await seedUserWithRole(ds, 'legal_rep', { fullName: 'Gone', isActive: false });
    await seedUserWithRole(ds, 'admin', { fullName: 'An Admin' });
    const requesterId = await seedUserWithRole(ds, 'requester', { fullName: 'A Requester' });
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/case-holders', headers: authHeader(app, requesterId, 'requester') });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }[]).map((p) => p.id)).toEqual([repId, managerId]);
    const anonymous = await app.inject({ method: 'GET', url: '/case-holders' });
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });
});
