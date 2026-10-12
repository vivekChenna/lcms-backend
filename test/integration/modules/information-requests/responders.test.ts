import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { authHeader } from '../../helpers/auth-header';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { resetDatabase } from '../../helpers/reset-db';

describe('GET /cases/:id/information-request-responders', () => {
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

  async function world() {
    await resetDatabase(ds);
    const master = await seedCaseMasterData(ds);
    const [other] = await ds.query(`INSERT INTO departments (id, name) VALUES (gen_random_uuid(), 'Elsewhere-' || substr(md5(random()::text), 1, 6)) RETURNING id`);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { fullName: 'Raised It', departmentId: master.departmentId, entityId: master.entityId });
    const colleagueId = await seedUserWithRole(ds, 'requester', { fullName: 'Same Dept', departmentId: master.departmentId, entityId: master.entityId });
    const inactiveId = await seedUserWithRole(ds, 'requester', { fullName: 'Left Company', isActive: false, departmentId: master.departmentId });
    const strangerId = await seedUserWithRole(ds, 'requester', { fullName: 'Other Dept', departmentId: other.id });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    return { repId, requesterId, colleagueId, inactiveId, strangerId, caseRow };
  }

  it('offers the active people of the case department, including who raised it, and nobody else', async () => {
    const w = await world();
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/cases/${w.caseRow.id}/information-request-responders`,
      headers: authHeader(app, w.repId, 'legal_rep'),
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { id: string }[]).map((p) => p.id);
    expect(ids.sort()).toEqual([w.requesterId, w.colleagueId].sort());
    expect(ids).not.toContain(w.strangerId);
    expect(ids).not.toContain(w.inactiveId);
    expect(ids).not.toContain(w.repId);
    await app.close();
  });

  it('is for legal staff only', async () => {
    const w = await world();
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/cases/${w.caseRow.id}/information-request-responders`,
      headers: authHeader(app, w.requesterId, 'requester'),
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets the chosen colleague answer, and the case then shows for them', async () => {
    const w = await world();
    const app = buildTestApp(ds);
    await app.ready();

    const raised = await app.inject({
      method: 'POST',
      url: `/cases/${w.caseRow.id}/information-requests`,
      headers: authHeader(app, w.repId, 'legal_rep'),
      payload: { subject: 'Need a figure', requirementDescription: 'What was the invoice total?', responderId: w.colleagueId },
    });
    expect(raised.statusCode).toBe(201);

    const asColleague = authHeader(app, w.colleagueId, 'requester');
    const seen = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}`, headers: asColleague });
    expect(seen.statusCode).toBe(200);
    const answered = await app.inject({
      method: 'POST',
      url: `/information-requests/${raised.json().id}/respond`,
      headers: asColleague,
      payload: { responseText: 'It was 4,200.' },
    });
    expect(answered.statusCode).toBe(200);
    await app.close();
  });

  it('lets a legal manager who holds the case raise a request too', async () => {
    await resetDatabase(ds);
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId: responderId, status: 'In Progress', assignedLegalRepId: managerId, assignmentAcceptedAt: new Date() });
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, managerId, 'legal_manager'),
      payload: { subject: 'Need a figure', requirementDescription: 'What was the invoice total?', responderId },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
