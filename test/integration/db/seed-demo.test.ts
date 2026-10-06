import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { resetDatabase } from '../helpers/reset-db';
import { seedDemo } from '../../../src/db/seed-demo';
import { Case } from '../../../src/modules/cases/entities/case.entity';
import { toCaseWithSla } from '../../../src/modules/cases/sla';

describe('seedDemo', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
    await resetDatabase(ds);
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('creates one user per role and cases in every status, then is idempotent', async () => {
    const first = await seedDemo(ds);

    expect(Object.keys(first.users).sort()).toEqual(['admin', 'manager', 'requester', 'rep1', 'rep2', 'viewer'].sort());
    const roles = await ds.query(
      `SELECT u.email, r.name AS role FROM users u JOIN user_roles ur ON ur."userId" = u.id JOIN roles r ON r.id = ur."roleId"`,
    );
    const roleByEmail = Object.fromEntries(roles.map((r: { email: string; role: string }) => [r.email, r.role]));
    expect(roleByEmail).toEqual({
      'vivekadmin@gmail.com': 'admin',
      'viveklegalmanager@gmail.com': 'legal_manager',
      'viveklegalrep@gmail.com': 'legal_rep',
      'viveklegalrep2@gmail.com': 'legal_rep',
      'vivek@gmail.com': 'requester',
      'vivekviewer@gmail.com': 'viewer',
    });

    const cases = await ds.getRepository(Case).find();
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(first.caseIds).toHaveLength(cases.length);
    expect(new Set(cases.map((c) => c.status))).toEqual(
      new Set(['Submitted', 'Assigned', 'In Progress', 'Waiting on Input', 'Closed']),
    );
    expect(cases.filter((c) => c.isConfidential)).toHaveLength(1);
    expect(cases.filter((c) => toCaseWithSla(c).slaState === 'breached')).toHaveLength(1);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM audit_log`);
    expect(count).toBeGreaterThan(0);

    const second = await seedDemo(ds);
    expect(second.users).toEqual(first.users);
    expect(second.caseIds).toEqual(first.caseIds);
    expect(await ds.getRepository(Case).count()).toBe(cases.length);
    const [{ users }] = await ds.query(`SELECT COUNT(*)::int AS users FROM users`);
    expect(users).toBe(6);
  });

  it('refuses to run in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(seedDemo(ds)).rejects.toThrow('seed:demo must not run in production');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
