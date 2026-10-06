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

describe('GET /dashboard', () => {
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

  // Six cases: A Submitted (future due), B Assigned to rep (future), C In Progress rep OVERDUE,
  // D Waiting on Input other rep (future), E Closed on time, F Closed LATE (due in the past).
  async function seedWorld() {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const base = { ...master, requesterId };
    const a = await seedCaseWithTimes(ds, { ...base, status: 'Submitted', resolutionDueAt: inHours(48), createdAt: inHours(-5) });
    const b = await seedCaseWithTimes(ds, { ...base, status: 'Assigned', assignedLegalRepId: repId, resolutionDueAt: inHours(48), createdAt: inHours(-4) });
    const c = await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: repId, resolutionDueAt: inHours(-1), createdAt: inHours(-100) });
    const d = await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', assignedLegalRepId: otherRepId, resolutionDueAt: inHours(48), createdAt: inHours(-3) });
    const e = await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: repId, resolutionDueAt: inHours(10), closedAt: inHours(-2), createdAt: inHours(-50) });
    const f = await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: repId, resolutionDueAt: inHours(-20), closedAt: inHours(-2), createdAt: inHours(-60) });
    return { master, repId, otherRepId, requesterId, a, b, c, d, e, f };
  }

  it('gives a legal manager every tile, all five statuses and both manager panels', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const world = await seedWorld();
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tiles).toEqual({ total: 6, open: 4, awaitingAcceptance: 1, waitingOnInput: 1, overdue: 1, onTime: 5, closed: 2 });
    expect(body.byStatus).toEqual([
      { status: 'Submitted', count: 1 },
      { status: 'Assigned', count: 1 },
      { status: 'In Progress', count: 1 },
      { status: 'Waiting on Input', count: 1 },
      { status: 'Closed', count: 2 },
    ]);
    expect(body.filters.overdue).toEqual({ open: 'true', slaState: 'breached' });
    expect(body.filters.onTime).toBeUndefined();
    expect(body).not.toHaveProperty('myAssignedCases');
    const panels = body.managerPanels;
    expect(panels.unassigned.count).toBe(1);
    expect(panels.unassigned.items.map((item: { id: string }) => item.id)).toEqual([world.a.id]);
    expect(panels.awaitingAcceptance.count).toBe(1);
    expect(panels.awaitingAcceptance.items[0]).toMatchObject({ id: world.b.id, status: 'Assigned', priority: 'P3' });
    expect(typeof panels.awaitingAcceptance.items[0].resolutionDueAt).toBe('string');
    expect(panels.openCaseloadByRep).toEqual([
      { legalRepId: world.repId, fullName: expect.any(String), openCount: 2, overdueCount: 1 },
      { legalRepId: world.otherRepId, fullName: expect.any(String), openCount: 1, overdueCount: 0 },
    ]);
    await app.close();
  });

  it('does not count a case closed late as overdue, nor an open case due in the future', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    await seedCaseWithTimes(ds, { ...master, requesterId, status: 'Closed', resolutionDueAt: inHours(-20), closedAt: inHours(-2) });
    await seedCaseWithTimes(ds, { ...master, requesterId, status: 'In Progress', resolutionDueAt: inHours(1) });
    await seedCaseWithTimes(ds, { ...master, requesterId, status: 'In Progress', resolutionDueAt: new Date(Date.now() - 1000) });

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.json().tiles.overdue).toBe(1);
    expect(res.json().tiles.onTime).toBe(2);
    await app.close();
  });

  it('returns all zeros and all five statuses when there are no cases', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    const body = res.json();
    expect(body.tiles).toEqual({ total: 0, open: 0, awaitingAcceptance: 0, waitingOnInput: 0, overdue: 0, onTime: 0, closed: 0 });
    expect(body.byStatus).toHaveLength(5);
    expect(body.byStatus.every((row: { count: number }) => row.count === 0)).toBe(true);
    expect(body.managerPanels.openCaseloadByRep).toEqual([]);
    await app.close();
  });

  it('scopes a legal rep to their own cases and adds myAssignedCases', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const world = await seedWorld();

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, world.repId, 'legal_rep') });

    const body = res.json();
    expect(body.tiles).toEqual({ total: 4, open: 2, awaitingAcceptance: 1, waitingOnInput: 0, overdue: 1, onTime: 3, closed: 2 });
    expect(body.myAssignedCases.map((item: { id: string }) => item.id)).toEqual([world.b.id]);
    expect(body).not.toHaveProperty('managerPanels');
    await app.close();
  });

  it('scopes a requester to the cases they can see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const world = await seedWorld();
    const otherMaster = await seedCaseMasterData(ds);
    const otherRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedCaseWithTimes(ds, { ...otherMaster, requesterId: otherRequesterId, status: 'Submitted' });

    const mine = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, world.requesterId, 'requester') });
    const theirs = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, otherRequesterId, 'requester') });

    expect(mine.json().tiles.total).toBe(6);
    expect(theirs.json().tiles.total).toBe(1);
    expect(mine.json()).not.toHaveProperty('managerPanels');
    expect(mine.json()).not.toHaveProperty('myAssignedCases');
    await app.close();
  });

  it('gives admin the manager panels and a viewer only tiles and the chart', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedWorld();
    const adminId = await seedUserWithRole(ds, 'admin');
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const admin = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, adminId, 'admin') });
    const viewer = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, viewerId, 'viewer') });

    expect(admin.json().managerPanels).toBeDefined();
    expect(viewer.json().tiles.total).toBe(6);
    expect(viewer.json()).not.toHaveProperty('managerPanels');
    expect(viewer.json()).not.toHaveProperty('myAssignedCases');
    await app.close();
  });

  it('every tile filter replays through GET /cases to the same count', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedWorld();
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const headers = authHeader(app, managerId, 'legal_manager');
    const dashboard = (await app.inject({ method: 'GET', url: '/dashboard', headers })).json();

    for (const tile of ['total', 'open', 'awaitingAcceptance', 'waitingOnInput', 'overdue', 'closed'] as const) {
      const params = new URLSearchParams({ ...dashboard.filters[tile], pageSize: '100' });
      const list = await app.inject({ method: 'GET', url: `/cases?${params.toString()}`, headers });
      expect(list.json().total, tile).toBe(dashboard.tiles[tile]);
    }
    await app.close();
  });

  it('every tile filter replays through GET /cases to the same count for a legal rep', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const world = await seedWorld();
    const headers = authHeader(app, world.repId, 'legal_rep');
    const dashboard = (await app.inject({ method: 'GET', url: '/dashboard', headers })).json();

    for (const tile of ['total', 'open', 'awaitingAcceptance', 'waitingOnInput', 'overdue', 'closed'] as const) {
      const params = new URLSearchParams({ ...dashboard.filters[tile], pageSize: '100' });
      const list = await app.inject({ method: 'GET', url: `/cases?${params.toString()}`, headers });
      expect(list.json().total, tile).toBe(dashboard.tiles[tile]);
    }
    await app.close();
  });

  it('caps each panel at 20 items, oldest first, while the count stays exact', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    for (let i = 0; i < 22; i += 1) {
      await seedCaseWithTimes(ds, { ...master, requesterId, status: 'Submitted', createdAt: inHours(-(100 - i)), referenceNumber: `CAP-${String(i).padStart(2, '0')}` });
    }

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    const unassigned = res.json().managerPanels.unassigned;
    expect(unassigned.count).toBe(22);
    expect(unassigned.items).toHaveLength(20);
    expect(unassigned.items[0].referenceNumber).toBe('CAP-00');
    await app.close();
  });

  it('requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/dashboard' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
