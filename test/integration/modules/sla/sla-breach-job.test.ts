// test/integration/modules/sla/sla-breach-job.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { listNotificationsFor } from '../../helpers/seed-notification';
import { Case } from '../../../../src/modules/cases/entities/case.entity';
import { scanForSlaBreaches } from '../../../../src/modules/sla/sla-breach-job';

describe('scanForSlaBreaches', () => {
  let ds: DataSource;
  let master: Awaited<ReturnType<typeof seedCaseMasterData>>;
  let requesterId: string;

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
    master = await seedCaseMasterData(ds);
    requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
  });

  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  async function seedDueCase(opts: { status?: Case['status']; dueInHours?: number; stamped?: boolean } = {}): Promise<Case> {
    const caseRow = await seedCase(ds, { ...master, requesterId, status: opts.status ?? 'In Progress' });
    await ds.getRepository(Case).update(caseRow.id, {
      resolutionDueAt: hoursFromNow(opts.dueInHours ?? -2),
      slaBreachNotifiedAt: opts.stamped ? new Date() : null,
    });
    return caseRow;
  }

  async function stamped(caseId: string): Promise<boolean> {
    const row = await ds.getRepository(Case).findOneByOrFail({ id: caseId });
    return row.slaBreachNotifiedAt !== null;
  }

  async function breachNotificationCount(): Promise<number> {
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE type = 'sla.breached'`);
    return count;
  }

  it('notifies each active legal manager once, skips inactive managers, and stamps the case', async () => {
    const m1 = await seedUserWithRole(ds, 'legal_manager');
    const m2 = await seedUserWithRole(ds, 'legal_manager');
    const inactive = await seedUserWithRole(ds, 'legal_manager', { isActive: false });
    const caseRow = await seedDueCase();

    const result = await scanForSlaBreaches(ds);

    expect(result.notified).toBe(1);
    for (const id of [m1, m2]) {
      const rows = await listNotificationsFor(ds, id);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('sla.breached');
      expect(rows[0].relatedCaseId).toBe(caseRow.id);
      expect(rows[0].body).toContain(caseRow.referenceNumber);
    }
    expect(await listNotificationsFor(ds, inactive)).toHaveLength(0);
    expect(await stamped(caseRow.id)).toBe(true);
  });

  it('does not notify again on a second scan', async () => {
    const manager = await seedUserWithRole(ds, 'legal_manager');
    await seedDueCase();

    await scanForSlaBreaches(ds);
    const second = await scanForSlaBreaches(ds);

    expect(second.notified).toBe(0);
    expect(await listNotificationsFor(ds, manager)).toHaveLength(1);
  });

  it('skips Closed, not-yet-due and already-stamped cases', async () => {
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const closed = await seedDueCase({ status: 'Closed' });
    const notDue = await seedDueCase({ dueInHours: 5 });
    await seedDueCase({ stamped: true });

    const result = await scanForSlaBreaches(ds);

    expect(result.notified).toBe(0);
    expect(await listNotificationsFor(ds, manager)).toHaveLength(0);
    expect(await stamped(closed.id)).toBe(false);
    expect(await stamped(notDue.id)).toBe(false);
  });

  it('treats Waiting on Input and Submitted overdue cases as open', async () => {
    await seedUserWithRole(ds, 'legal_manager');
    const waiting = await seedDueCase({ status: 'Waiting on Input' });
    const submitted = await seedDueCase({ status: 'Submitted' });

    const result = await scanForSlaBreaches(ds);

    expect(result.notified).toBe(2);
    expect(await stamped(waiting.id)).toBe(true);
    expect(await stamped(submitted.id)).toBe(true);
  });

  it('stamps an overdue case even when there are no active legal managers', async () => {
    const caseRow = await seedDueCase();

    const result = await scanForSlaBreaches(ds);

    expect(result.notified).toBe(1);
    expect(await stamped(caseRow.id)).toBe(true);
    expect(await breachNotificationCount()).toBe(0);
  });

  it('honours batchSize', async () => {
    await seedUserWithRole(ds, 'legal_manager');
    const cases = [await seedDueCase(), await seedDueCase(), await seedDueCase()];

    const result = await scanForSlaBreaches(ds, { batchSize: 2 });

    expect(result.notified).toBe(2);
    const flags = await Promise.all(cases.map((c) => stamped(c.id)));
    expect(flags.filter(Boolean)).toHaveLength(2);
  });

  it('notifies each case exactly once when two scans run concurrently', async () => {
    await seedUserWithRole(ds, 'legal_manager');
    await seedUserWithRole(ds, 'legal_manager');
    const cases = [await seedDueCase(), await seedDueCase(), await seedDueCase(), await seedDueCase()];

    const [a, b] = await Promise.all([scanForSlaBreaches(ds), scanForSlaBreaches(ds)]);

    expect(a.notified + b.notified).toBe(4);
    for (const c of cases) {
      const [{ count }] = await ds.query(
        `SELECT COUNT(*)::int AS count FROM notifications WHERE type = 'sla.breached' AND "relatedCaseId" = $1`,
        [c.id],
      );
      expect(count).toBe(2);
      expect(await stamped(c.id)).toBe(true);
    }
  });
});
