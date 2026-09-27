import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestDataSource } from '../helpers/test-data-source';
import type { DataSource } from 'typeorm';

describe('users/roles schema', () => {
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

  it('seeds exactly the five required roles', async () => {
    const rows = await ds.query('SELECT name FROM roles ORDER BY name');
    expect(rows.map((r: { name: string }) => r.name)).toEqual([
      'admin',
      'legal_manager',
      'legal_rep',
      'requester',
      'viewer',
    ]);
  });

  it('rejects a second active role row for the same user (VC-16)', async () => {
    const [role] = await ds.query(`SELECT id FROM roles WHERE name = 'requester'`);
    const [user] = await ds.query(
      `INSERT INTO users ("fullName", email, "passwordHash") VALUES ('Test User', 'dup@test.local', 'x') RETURNING id`,
    );
    await ds.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [user.id, role.id]);

    await expect(
      ds.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [user.id, role.id]),
    ).rejects.toThrow();
  });
});
