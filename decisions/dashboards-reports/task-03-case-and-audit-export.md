# Task 3 — Case repository and audit CSV exports

**Date:** 2026-10-08

**What:** Added `GET /cases/export` and `GET /audit/export`, both returning CSV via the Task 2 builder. The case export reuses `applyCaseFilters` through `listCasesForExport`, so it applies the same role scoping and filters as the list, minus pagination, and never includes the case description. The audit export takes the `GET /audit` filters and is limited to admin and legal manager. Both cap rows in the query (`exportRowCap`, default 10,000) and report the true total and a truncation flag in `X-Export-Total` and `X-Export-Truncated`. `exportRowCap` is plumbed through `buildApp`/`buildTestApp` into both route plugins.

**Why:** Legal staff need to take the case repository and the audit trail into spreadsheets. Reusing the list filters keeps an export identical to what the user sees on screen and means access rules cannot drift between the two. Capping in the SQL query rather than after loading protects memory, and the headers let clients warn when an export was cut off. The static `/cases/export` route is registered before `/cases/:id` and a test confirms it does not shadow it.
