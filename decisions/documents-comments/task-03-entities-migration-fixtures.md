# Task 3 — Entities, migration, reset helper, fixtures

**Date:** 2026-10-06

**What:** Added the `documents` and `comments` tables (migration 1700000012000) with RESTRICT foreign keys, the `CaseDocument` and `CaseComment` entities, and test fixtures (`seedDocument`, `seedComment`, `seedCaseWithParties`). `resetDatabase` now deletes `comments` and `documents` before `information_requests`. `documents.sizeBytes` is a bigint with a transformer that returns a JS number.

**Why:** Later tasks build the upload and comment routes on these tables. The reset helper is shared by every integration test file, so the new tables must be cleared ahead of the tables they reference (`cases`, `users`, `information_requests`) or unrelated suites would fail with FK violations. Versioning is modelled with `rootDocumentId` (self for v1) and `previousVersionId`, both self-referencing RESTRICT FKs. The migration is last, so its `down()` drops `comments` then `documents` for the per-file `undoLastMigration` teardown.
