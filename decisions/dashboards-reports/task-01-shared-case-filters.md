# Task 1 — Shared case filters and the open filter

**Date:** 2026-10-08

**What:** Extracted the requester scope and every case filter from `listCases` into an exported `applyCaseFilters(qb, actor, query)` in `src/modules/cases/cases.service.ts`, split the filter fields into an exported `CaseFilterQuery` type (`CaseListQuery` is now `PaginationQuery & CaseFilterQuery`), and exported `SLA_STATE_CONDITIONS`. Added an `open` filter (`GET /cases?open=true` returns only cases whose status is not Closed); the schema accepts only the literal `true`, so other values return 400 and omitting it changes nothing.

**Why:** The dashboard, reports and exports must count the same cases as the list. Sharing one filter function means a tile, a chart bar, a CSV row and a list row can never disagree, and `open` gives the dashboard's "open cases" tile a list view to link to.
