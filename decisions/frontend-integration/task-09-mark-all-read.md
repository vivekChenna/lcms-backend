# Task 9 — Mark all notifications read

**Date:** 2026-10-09

**What:** New `PATCH /notifications/read-all` (any authenticated role) marks every unread notification of the caller as read in one UPDATE (`readAt = now()`) and returns `{ updated: <count> }`. Rows of other users and rows already read are never touched, so the first `readAt` is preserved and a second call returns `{ updated: 0 }`. The service is `markAllNotificationsRead` in `src/modules/notifications/notifications.service.ts`.

**Why:** The frontend bell menu needs a "mark all as read" action without one request per notification. The user id comes from the token, never from the request, so only the caller's rows can change. The path `/notifications/read-all` has a different shape from `/notifications/:id/read`, so the two routes do not collide.
