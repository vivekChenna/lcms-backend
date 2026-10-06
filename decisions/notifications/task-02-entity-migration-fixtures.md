# Task 2 — Notification entity, migration, reset helper, fixtures

**Date:** 2026-10-06

**What:** Added the `AppNotification` entity and `EmailStatus` type, the `notifications` table migration (FKs to users and cases with RESTRICT, a user/read/created index and a partial index on pending email), registered both in the entity and migration lists, added `notifications` to the integration reset order, and added `seedNotification` / `listNotificationsFor` fixtures with an entity round-trip test.

**Why:** Notifications carry both the in-app state and the email delivery state (status, attempts, next attempt) on one row, so a later dispatcher can poll pending rows via the partial index. Because the table references users and cases with RESTRICT, it must be cleared before them in `resetDatabase`, otherwise every other test file's reset would hit a foreign-key violation once a notification exists.
