import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { seedUserWithRole } from '../../helpers/seed-user';
import { evaluateAutoRouting } from '../../../../src/modules/cases/auto-routing';

describe('evaluateAutoRouting', () => {
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

  it('returns the highest-priority matching active rule, ignoring inactive ones', async () => {
    await ds.query('DELETE FROM routing_rules');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');

    const repA = await seedUserWithRole(ds, 'legal_rep');
    const repB = await seedUserWithRole(ds, 'legal_rep');

    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 5, true)`,
      [JSON.stringify({ categoryId: 'cat-1' }), repA],
    );
    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 1, true)`,
      [JSON.stringify({ categoryId: 'cat-1' }), repB],
    );
    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 0, false)`,
      [JSON.stringify({ categoryId: 'cat-1' }), repA],
    );

    const match = await evaluateAutoRouting(ds, {
      categoryId: 'cat-1',
      caseTypeId: 'type-1',
      entityId: 'entity-1',
      businessUnitId: null,
      departmentId: 'dept-1',
      priority: 'P3',
    });

    expect(match?.targetLegalRepId).toBe(repB);
  });

  it('returns null when no active rule matches', async () => {
    await ds.query('DELETE FROM routing_rules');
    const match = await evaluateAutoRouting(ds, {
      categoryId: 'no-match',
      caseTypeId: 'type-1',
      entityId: 'entity-1',
      businessUnitId: null,
      departmentId: 'dept-1',
      priority: 'P3',
    });
    expect(match).toBeNull();
  });
});
