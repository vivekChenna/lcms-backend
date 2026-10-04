# Task 1 (fix round) — Org-structure test tolerates rows added by other suites

**Date:** 2026-10-04

**What:** Changed org-structure test "seeds the 10 required entities (DM-03)" from asserting exact entity count to checking that 10 known seeded codes are present as a subset of results.

**Why:** The exact-count assertion (`toHaveLength(10)`) was fragile: other test suites (e.g., case-core fixtures) insert rows into the shared `entities` table without cleanup. The test doesn't own the table and shouldn't enforce its total size; it should only verify the migration seeded the 10 known codes. Changed to `arrayContaining` to tolerate extra rows from other suites. (A `beforeEach` delete, the pattern used elsewhere, was considered and rejected — `entities` is migration-seeded fixed data, not per-test-created data, so deleting it would have broken the test's own premise.)
