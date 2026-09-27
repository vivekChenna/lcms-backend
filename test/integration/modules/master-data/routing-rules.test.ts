import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

async function createLegalRep(app: ReturnType<typeof buildTestApp>, token: string, email: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { authorization: `Bearer ${token}` },
    payload: { fullName: 'Legal Rep', email, password: 'Password123!' },
  });
  const userId = created.json().id;
  await app.inject({
    method: 'PATCH',
    url: `/users/${userId}/role`,
    headers: { authorization: `Bearer ${token}` },
    payload: { role: 'legal_rep' },
  });
  return userId;
}

describe('/routing-rules', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    for (let i = 0; i < 6; i += 1) {
      await ds.undoLastMigration();
    }
    await ds.destroy();
  });

  beforeEach(async () => {
    // No beforeEach in the brief's own test — added because test 1's routing
    // rule otherwise leaks into test 3's unfiltered GET /routing-rules,
    // producing 3 rows instead of the expected 2. FK order matters:
    // routing_rules references users, so it must be cleared first.
    await ds.query('DELETE FROM routing_rules');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('creates a routing rule targeting a legal_rep user', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);
    const legalRepId = await createLegalRep(app, token, 'rep1@algihaz.local');

    const res = await app.inject({
      method: 'POST',
      url: '/routing-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { matchCriteria: { departmentId: null }, targetLegalRepId: legalRepId, priorityOrder: 1 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().targetLegalRepId).toBe(legalRepId);

    await app.close();
  });

  it('rejects a routing rule targeting a requester (VC-07: only legal_rep/legal_manager)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Plain Requester', email: 'requester1@algihaz.local', password: 'Password123!' },
    });
    const requesterId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: '/routing-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { matchCriteria: {}, targetLegalRepId: requesterId, priorityOrder: 1 },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists routing rules ordered by priorityOrder', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);
    const repA = await createLegalRep(app, token, 'rep2@algihaz.local');
    const repB = await createLegalRep(app, token, 'rep3@algihaz.local');

    await app.inject({ method: 'POST', url: '/routing-rules', headers: { authorization: `Bearer ${token}` }, payload: { matchCriteria: {}, targetLegalRepId: repA, priorityOrder: 5 } });
    await app.inject({ method: 'POST', url: '/routing-rules', headers: { authorization: `Bearer ${token}` }, payload: { matchCriteria: {}, targetLegalRepId: repB, priorityOrder: 1 } });

    const res = await app.inject({ method: 'GET', url: '/routing-rules', headers: { authorization: `Bearer ${token}` } });
    const order = res.json().map((r: { targetLegalRepId: string }) => r.targetLegalRepId);
    expect(order).toEqual([repB, repA]);

    await app.close();
  });

  it('records the ORIGINAL target in the audit before-value when retargeting (code review finding)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);
    const repA = await createLegalRep(app, token, 'rep4@algihaz.local');
    const repB = await createLegalRep(app, token, 'rep5@algihaz.local');

    const created = await app.inject({
      method: 'POST',
      url: '/routing-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { matchCriteria: {}, targetLegalRepId: repA, priorityOrder: 1 },
    });
    const ruleId = created.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/routing-rules/${ruleId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { targetLegalRepId: repB },
    });

    const [entry] = await ds.query(
      `SELECT "beforeValue", "afterValue" FROM audit_log WHERE action = 'routing_rule.updated'`,
    );
    expect(entry.beforeValue.targetLegalRepId).toBe(repA);
    expect(entry.afterValue.targetLegalRepId).toBe(repB);

    await app.close();
  });

  it('rejects a routing rule targeting a deactivated legal_rep (code review finding)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);
    const repId = await createLegalRep(app, token, 'rep6@algihaz.local');
    await app.inject({ method: 'PATCH', url: `/users/${repId}/deactivate`, headers: { authorization: `Bearer ${token}` } });

    const res = await app.inject({
      method: 'POST',
      url: '/routing-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { matchCriteria: {}, targetLegalRepId: repId, priorityOrder: 1 },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
