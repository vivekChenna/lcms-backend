import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedUserWithRole } from '../../helpers/seed-user';

describe('Case entity + migration', () => {
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

  it('round-trips a case row through the repository', async () => {
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
    await ds.query('DELETE FROM business_units');
    await ds.query('DELETE FROM case_types');
    await ds.query('DELETE FROM departments');

    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });

    const caseRow = await seedCase(ds, { ...master, requesterId });

    expect(caseRow.id).toBeTruthy();
    expect(caseRow.referenceNumber).toBeTruthy();
    expect(caseRow.status).toBe('Submitted');
    expect(caseRow.priority).toBe('P3');
    expect(caseRow.ackDueAt).toBeInstanceOf(Date);
    expect(caseRow.resolutionDueAt).toBeInstanceOf(Date);
    expect(caseRow.businessUnitId).toBe(master.businessUnitId);
  });
});
