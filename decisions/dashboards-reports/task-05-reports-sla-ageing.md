# Task 5 — SLA compliance and ageing reports

**Date:** 2026-10-08

**What:** Added the reports plugin with `GET /reports/sla-compliance` and `GET /reports/ageing` plus a CSV export for each, open to admin, legal manager and viewer. Both reports take the shared case filters and a `createdFrom`/`createdTo` range (400 when reversed or invalid). SLA compliance returns closed on time/late, open on track/at risk/breached and a compliance percentage (null when nothing is closed). Ageing always returns the four buckets 0-7, 8-30, 31-90 and 91+ for open cases only.

**Why:** Managers need SLA and backlog-age views that agree with the case list, so the reports reuse `applyCaseFilters` and `SLA_STATE_CONDITIONS` instead of re-deriving the rules. Counting with `FILTER` aggregates keeps each report to one query, and a shared `reportBaseQuery` and plugin let the remaining reports slot in without new plumbing.
