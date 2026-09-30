import crypto from 'node:crypto';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../../../src/shared/password';

export type SeedableRole = 'admin' | 'legal_manager' | 'legal_rep' | 'requester' | 'viewer';

// Seeds a real users + user_roles row and returns its id, so tests can mint
// a token for an id that actually resolves through the (now fail-closed)
// authenticate preHandler, instead of a fake id that only worked because of
// the fallback that preHandler used to have. Every test file runs in its
// own vitest worker against the same shared test Postgres (fileParallelism
// is off, but data isn't wiped between files unless a file's own beforeEach
// does it) — the random suffix keeps emails unique across files even though
// each worker's own counter-style state would otherwise start over.
export async function seedUserWithRole(
  ds: DataSource,
  role: SeedableRole,
  overrides: { email?: string; fullName?: string; isActive?: boolean } = {},
): Promise<string> {
  const email = overrides.email ?? `test-${role}-${crypto.randomUUID()}@algihaz.local`;
  const passwordHash = await hashPassword('Password123!');
  const [user] = await ds.query(
    `INSERT INTO users (id, "fullName", email, "passwordHash", "isActive")
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [overrides.fullName ?? 'Test User', email, passwordHash, overrides.isActive ?? true],
  );
  const [roleRow] = await ds.query(`SELECT id FROM roles WHERE name = $1`, [role]);
  await ds.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [user.id, roleRow.id]);
  return user.id as string;
}
