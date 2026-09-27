import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { seedAdmin } from '../../../src/db/seed-admin';

describe('seedAdmin', () => {
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

  it('creates a user with the admin role assigned', async () => {
    await seedAdmin(ds, { email: 'Admin@Test.local', password: 'InitialPass123!', fullName: 'Root Admin' });

    const [user] = await ds.query(`SELECT id, email, "isActive" FROM users WHERE email = $1`, ['admin@test.local']);
    expect(user).toBeDefined();
    expect(user.isActive).toBe(true);

    const [assignment] = await ds.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur."roleId" WHERE ur."userId" = $1`,
      [user.id],
    );
    expect(assignment.name).toBe('admin');
  });

  it('is idempotent — running it again for the same email does not throw or duplicate', async () => {
    await expect(
      seedAdmin(ds, { email: 'admin@test.local', password: 'Different123!' }),
    ).resolves.not.toThrow();

    const rows = await ds.query(`SELECT id FROM users WHERE email = $1`, ['admin@test.local']);
    expect(rows).toHaveLength(1);
  });
});
