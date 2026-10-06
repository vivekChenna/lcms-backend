// test/integration/modules/sla/sla-breach-worker.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { listNotificationsFor } from '../../helpers/seed-notification';
import { Case } from '../../../../src/modules/cases/entities/case.entity';
import { startSlaBreachWorker } from '../../../../src/modules/sla/sla-breach-job';

describe('startSlaBreachWorker', () => {
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

  async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 4000) {
    const started = Date.now();
    while (!(await condition())) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('condition not met in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function seedOverdueCase(): Promise<Case> {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress' });
    await ds.getRepository(Case).update(caseRow.id, { resolutionDueAt: new Date(Date.now() - 3_600_000) });
    return caseRow;
  }

  it('notifies for an overdue case on its own once started, and stops cleanly', async () => {
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const caseRow = await seedOverdueCase();

    const worker = startSlaBreachWorker({ dataSource: ds, intervalMs: 20 });
    await waitFor(async () => (await listNotificationsFor(ds, manager)).length === 1);
    await worker.stop();

    const rows = await listNotificationsFor(ds, manager);
    expect(rows).toHaveLength(1);
    expect(rows[0].relatedCaseId).toBe(caseRow.id);
  });

  it('reports a scan error to onError and keeps running', async () => {
    const errors: unknown[] = [];
    const brokenDataSource = { transaction: async () => { throw new Error('database unavailable'); } } as unknown as DataSource;

    const worker = startSlaBreachWorker({ dataSource: brokenDataSource, intervalMs: 15, onError: (error) => errors.push(error) });
    await waitFor(() => errors.length >= 2);
    await worker.stop();

    expect((errors[0] as Error).message).toBe('database unavailable');
  });

  it('stop() waits for the in-flight run and no further runs start afterwards', async () => {
    const manager = await seedUserWithRole(ds, 'legal_manager');
    await seedOverdueCase();

    const worker = startSlaBreachWorker({ dataSource: ds, intervalMs: 10 });
    await waitFor(async () => (await listNotificationsFor(ds, manager)).length === 1);
    await worker.stop();
    const late = await seedOverdueCase();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await listNotificationsFor(ds, manager)).toHaveLength(1);
    const row = await ds.getRepository(Case).findOneByOrFail({ id: late.id });
    expect(row.slaBreachNotifiedAt).toBeNull();
  });
});
