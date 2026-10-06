# Task 10 — Audit coverage guard (test-only)

**Date:** 2026-10-09

**What:** `test/integration/helpers/audit-manifest.ts` classifies every registered `POST`/`PATCH`/`PUT`/`DELETE` route as either audited (`AUDITED_ROUTES`, key → expected audit action) or exempt (`EXEMPT_ROUTES`, key → written reason). `buildTestApp` records every mutating route through an `onRoute` hook (`getRegisteredMutatingRoutes`), and `test/integration/audit-coverage.test.ts` fails if a route is unclassified, a manifest entry is stale, or a route is in both maps. `buildTestApp` also adds a runtime check to every integration test: a 2xx response on an audited route that wrote no `audit_log` row is replaced with `500 AUDIT_COVERAGE_MISSING`. No `src/` code changed.

**Why:** Every business mutation must leave an audit entry (BRD audit requirements). A new route that forgets `logAuditEvent` now fails the whole suite instead of shipping silently.

**Rows are counted by a TypeORM subscriber, not `SELECT COUNT(*)`:** the plan's version ran a count query inside an async `onSend` hook. Many handlers call `reply.send()` from an async handler without returning `reply`; while an async `onSend` hook is pending, Fastify's wrap-thenable sees the reply as not yet sent and sends a second, empty response (12 tests failed with "Unexpected end of JSON input"). Production has no async `onSend` hook, so this was purely a harness artifact. The guard now uses a per-DataSource `afterInsert` subscriber on `AuditLog` (every audit write goes through `logAuditEvent`'s repository save) and synchronous `onRequest`/`onSend` hooks, so it adds no I/O and does not change response timing.

**Exempt:** the four auth routes and the two notification read-state routes (as planned). `PATCH /users/:id/activate` was initially exempt too (the already-active no-op writes no row); Task 11 moved it to audited. No real audit gap was found.

- Later notes: the audit counter is global per DataSource, so concurrency or a rolled-back transaction can mask a gap but never fake one. The values in `AUDITED_ROUTES` are documentation only; the guard checks that a row was written, not which action. `PATCH /users/:id/activate` was moved from exempt to audited in Task 11 (the no-op test opts out with `exemptRoutes`).
