import type { DataSource } from 'typeorm';

// Deletes every "transactional" table that integration tests write to, in
// FK-safe order (each table before anything it references). Deliberately
// excludes roles/case_categories/entities/departments/business_units/
// case_types/closure_outcomes: those hold migration-seeded rows some tests
// rely on by name (e.g. case_categories.name = 'Internal'), and tests that
// add their own disposable rows to them (seedCaseMasterData) use random
// unique suffixes specifically so those rows can accumulate harmlessly
// across the whole suite run without needing per-test cleanup.
//
// Before this helper existed, each integration test file hand-rolled its
// own subset of these DELETEs, covering only the tables *it* happened to
// write to. That was consistent as long as every file touching a table
// also cleaned it — but a file whose last test left a `cases` or `users`
// row (because that file's own reset() never deleted them) silently leaked
// that row into every later file for the rest of the run. Once Phase 2
// added `cases` (users -> departments -> ... chains) and information-requests
// added `information_requests` (-> cases -> users), the FK graph got deep
// enough that almost any later file's unrelated DELETE could hit a stale
// row several files back and fail with a 23503 foreign-key violation.
// Every file now calls this one helper instead of hand-rolling its subset.
const RESET_TABLES_IN_ORDER = [
  'audit_log',
  'notifications',
  'comments',
  'documents',
  'information_requests',
  'refresh_tokens',
  'user_roles',
  'routing_rules',
  'cases',
  'users',
];

export async function resetDatabase(dataSource: DataSource): Promise<void> {
  for (const table of RESET_TABLES_IN_ORDER) {
    await dataSource.query(`DELETE FROM ${table}`);
  }
}
