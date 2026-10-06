import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { seedUserWithRole, type SeedableRole } from '../../helpers/seed-user';

describe('GET /audit', () => {
  let ds: DataSource;
  let userIds: Record<SeedableRole, string>;
  let adminId: string;

  function tokenFor(app: ReturnType<typeof buildTestApp>, role: SeedableRole) {
    return app.signAccessToken({ id: userIds[role], role, departmentId: null, entityId: null, businessUnitId: null });
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
    userIds = {
      admin: await seedUserWithRole(ds, 'admin'),
      legal_manager: await seedUserWithRole(ds, 'legal_manager'),
      legal_rep: await seedUserWithRole(ds, 'legal_rep'),
      requester: await seedUserWithRole(ds, 'requester'),
      viewer: await seedUserWithRole(ds, 'viewer'),
    };
    adminId = userIds.admin;
  });

  it('rejects an unauthenticated request', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/audit' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a requester role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = tokenFor(app, 'requester');
    const res = await app.inject({ method: 'GET', url: '/audit', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('orders rows sharing one createdAt by id so pages never repeat or skip', async () => {
    for (let i = 0; i < 5; i++) await logAuditEvent(ds, { actorId: adminId, action: 'user.created' });
    await ds.query(`UPDATE audit_log SET "createdAt" = '2026-01-01T00:00:00Z'`);
    const app = buildTestApp(ds);
    await app.ready();
    const token = tokenFor(app, 'admin');
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await app.inject({ method: 'GET', url: `/audit?page=${page}&pageSize=2`, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((r: { id: string }) => r.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());
    await app.close();
  });

  it('returns paginated entries for an admin', async () => {
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created' });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.deactivated' });

    const app = buildTestApp(ds);
    await app.ready();
    const token = tokenFor(app, 'admin');
    const res = await app.inject({ method: 'GET', url: '/audit', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    await app.close();
  });

  it('filters by action', async () => {
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created' });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.deactivated' });

    const app = buildTestApp(ds);
    await app.ready();
    const token = tokenFor(app, 'legal_manager');
    const res = await app.inject({
      method: 'GET',
      url: '/audit?action=user.created',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().items).toHaveLength(1);
    await app.close();
  });
});
