# Task 7 — In-app notification API

**Date:** 2026-10-06

**What:**
Added `GET /notifications` (paginated, newest first, optional `isRead` filter, returns `unreadCount`) and `PATCH /notifications/:id/read` under `src/modules/notifications/` (schemas, service, routes), registered in `src/app.ts`. Added `test/integration/modules/notifications/notifications-api.test.ts` (8 tests).

**Why:**
Users need to read their own notifications in the app. Every query is scoped to the caller's `userId`, so another user's notification returns 404 rather than leaking its existence. `unreadCount` ignores the `isRead` filter so it can drive the bell badge. Marking read is idempotent: a second call keeps the original `readAt`. Responses omit `userId` and `emailStatus`. Any authenticated role, including viewer, may use both routes because they only touch the caller's own rows.
