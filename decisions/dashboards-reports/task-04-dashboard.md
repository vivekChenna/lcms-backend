# Task 4 — Dashboard

**Date:** 2026-10-08

**What:** Added `GET /dashboard` for any authenticated role. It returns the tile counts (total, open, awaiting acceptance, waiting on input, overdue, on time, closed), the exact `GET /cases` query each tile maps to, and a five-status breakdown. Legal reps also get their assigned-cases panel, and legal managers and admins get the caseload-by-rep, unassigned and awaiting-acceptance panels (at most 20 items each, oldest first, exact counts). Scope comes from `applyCaseFilters`, with legal reps limited to their own cases. Added the `seedCaseWithTimes` test fixture for setting `createdAt`, `resolutionDueAt` and `closedAt`.

**Why:** Each role needs a landing view of its workload, and tiles that replay through `GET /cases` to the same count keep the dashboard and the list from drifting. Reusing the shared filter keeps access rules in one place, and counting with `FILTER` aggregates keeps each tile set to one query. Overdue means open and past its resolution due time, so a case closed late is not counted as overdue.
