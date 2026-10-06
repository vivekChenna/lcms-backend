# Task 11 — Final review fixes

**Date:** 2026-10-07

**What:** (1) The `estimatedValue` Zod limit on case create and patch is now 999_999_999_999.99, matching the `numeric(14,2)` column. (2) The app logs a startup warning when `CORS_ORIGINS` is empty; documented in `.env.example` and Task 1. (3) `PATCH /users/:id/activate` moved from exempt to audited (`user.activated`); `buildTestApp` gained `exemptRoutes` so the idempotent no-op activation test can opt out. (4) `GET /audit` now orders by `createdAt DESC, id DESC`, as the export and case audit already did. (5) `case-audit.service.ts` uses `isLegalRole` from `case-access.ts` instead of its own role list. (6) Client notes added to Tasks 2, 9 and 10.

**Why:** The old limit let a value pass validation and then fail in Postgres with `numeric field overflow` (500). Without a tie-breaker, rows sharing a timestamp could repeat or vanish between pages. The real activation path was unguarded, so a dropped audit call would have gone unnoticed. One role list avoids the copies drifting apart.
