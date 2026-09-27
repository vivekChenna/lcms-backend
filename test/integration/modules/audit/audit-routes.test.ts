import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function tokenFor(app: ReturnType<typeof buildTestApp>, role: string) {
  return app.signAccessToken({ id: ADMIN_ID, role, departmentId: null, entityId: null, businessUnitId: null });
}

describe('GET /audit', () => {
  let ds: DataSource;

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
    await ds.query('DELETE FROM audit_log');
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

  it('returns paginated entries for an admin', async () => {
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.created' });
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.deactivated' });

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
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.created' });
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.deactivated' });

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
