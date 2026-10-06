import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithTimes } from '../../helpers/seed-case-times';
import { authHeader } from '../../helpers/auth-header';

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

describe('dashboard for a legal rep', () => {
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

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  // 5 cases: Submitted (unassigned), Assigned to rep, In Progress to rep, Waiting to other rep, Closed to rep
  async function world() {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Lina Lawyer' });
    const otherRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Other Rep' });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const base = { ...master, requesterId, resolutionDueAt: inHours(48) };
    const submitted = await seedCaseWithTimes(ds, { ...base, status: 'Submitted', createdAt: inHours(-5) });
    const assigned = await seedCaseWithTimes(ds, { ...base, status: 'Assigned', assignedLegalRepId: repId, createdAt: inHours(-4) });
    const inProgress = await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: repId, createdAt: inHours(-100) });
    const waiting = await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', assignedLegalRepId: otherRepId, createdAt: inHours(-3) });
    const closed = await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: repId, closedAt: inHours(-1), createdAt: inHours(-50) });
    return { repId, otherRepId, requesterId, submitted, assigned, inProgress, waiting, closed };
  }

  it('a legal rep gets organisation-wide tiles plus assignedToMe and unassigned', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.repId, 'legal_rep') });

    expect(res.statusCode).toBe(200);
    expect(res.json().tiles).toMatchObject({ total: 5, open: 4, awaitingAcceptance: 1, waitingOnInput: 1, closed: 1, assignedToMe: 2, unassigned: 1 });
    expect(res.json().filters.assignedToMe).toEqual({ open: 'true', assignedLegalRepId: w.repId });
    expect(res.json().filters.unassigned).toEqual({ status: 'Submitted' });
    await app.close();
  });

  it('myAssignedCases lists the rep\'s open cases oldest first, each with status and the assignee name', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.repId, 'legal_rep') });

    const items = res.json().myAssignedCases;
    expect(items.map((item: { id: string }) => item.id)).toEqual([w.inProgress.id, w.assigned.id]);
    expect(items.map((item: { status: string }) => item.status)).toEqual(['In Progress', 'Assigned']);
    expect(items[0].assignedLegalRepName).toBe('Lina Lawyer');
    await app.close();
  });

  it('caps myAssignedCases at 20 and keeps the tile count exact', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    for (let i = 0; i < 22; i += 1) {
      await seedCaseWithTimes(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, createdAt: inHours(-(100 - i)), referenceNumber: `REP-${String(i).padStart(2, '0')}` });
    }

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, repId, 'legal_rep') });

    expect(res.json().tiles.assignedToMe).toBe(22);
    expect(res.json().myAssignedCases).toHaveLength(20);
    expect(res.json().myAssignedCases[0].id).toBeTruthy();
    await app.close();
  });

  it('every tile filter replays through GET /cases to the same count for a rep, including the new tiles', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.repId, 'legal_rep');
    const dashboard = (await app.inject({ method: 'GET', url: '/dashboard', headers })).json();

    for (const tile of ['total', 'open', 'awaitingAcceptance', 'waitingOnInput', 'overdue', 'closed', 'assignedToMe', 'unassigned'] as const) {
      const params = new URLSearchParams({ ...dashboard.filters[tile], pageSize: '100' });
      const list = await app.inject({ method: 'GET', url: `/cases?${params.toString()}`, headers });
      expect(list.json().total, tile).toBe(dashboard.tiles[tile]);
    }
    await app.close();
  });

  it('assignedToMe is 0 for roles that cannot hold assignments, and panels carry the assignee name', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const manager = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });
    const requester = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.requesterId, 'requester') });

    expect(manager.json().tiles.assignedToMe).toBe(0);
    expect(requester.json().tiles.assignedToMe).toBe(0);
    const awaiting = manager.json().managerPanels.awaitingAcceptance.items[0];
    expect(awaiting.assignedLegalRepName).toBe('Lina Lawyer');
    const unassigned = manager.json().managerPanels.unassigned.items[0];
    expect(unassigned.assignedLegalRepName).toBeNull();
    await app.close();
  });
});
