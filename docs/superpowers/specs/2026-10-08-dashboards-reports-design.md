# Dashboards, Reports & CSV Export — Design Spec

Status: Draft for review
Date: 2026-10-08
Parent spec: `2026-09-27-lcms-backend-design.md` (§7 "Dashboards & reports")
Source requirements: BRD v1.0 — §8 DR-01..08, PR-32, PR-34, AC-05, UI-08..UI-11, AT-04, NF-01

## 1. Purpose & scope

Sixth and last sub-project of Phase 2 (case workflow). Delivers the data behind the
dashboard tiles and charts, the five management reports, and CSV export of reports,
the case repository and the audit log. The frontend is out of scope.

In scope:

- `GET /dashboard` — role-scoped summary tiles, status chart data and role panels
  (DR-01..05, UI-08..11).
- Five reports under `GET /reports/...` (DR-06) for admin, legal manager and viewer.
- CSV export for every report, for the case repository, and for the audit log
  (DR-07, PR-34, AT-04).
- One new case-list filter (`open`) so every dashboard tile can be reproduced exactly
  by the repository (UI-10/11), and a small refactor that shares the case filter
  logic between list, export, dashboard and reports.

Out of scope: charts/rendering, scheduled or emailed reports, PDF/Excel export,
saved report definitions, websockets/live push, caching (NF-01 is met by indexed
aggregate queries; revisit only if measured slow).

## 2. Decisions & assumptions

Answered by the project owner:

- **Audit export is included** (AT-04): `GET /audit/export`.
- **Report access:** admin, legal manager and viewer only (viewer export per PR-34).

Assumptions (BRD silent) — each is easy to change:

1. **Dashboard scope by role.** Requester: the cases they can already see (same
   department, or responder on an information request — same rule as `GET /cases`).
   Legal rep: cases assigned to them. Legal manager, admin, viewer: all cases.
2. **Definitions.** *Open* = status in Submitted, Assigned, In Progress, Waiting on
   Input (not Closed). *Awaiting acceptance* = status Assigned. *Overdue* = open and
   `resolutionDueAt < now()` (same rule as the SLA breach job and the `breached` SLA
   state for open cases). *On time* = total minus overdue. Waiting on Input does not
   pause the SLA clock (consistent with the existing derived SLA state).
3. **Ageing buckets** (open cases, by days since `createdAt`): 0–7, 8–30, 31–90, 91+.
4. **SLA compliance %** = closed-on-time ÷ all closed cases; `null` when nothing is
   closed in the selected range.
5. **Export is separate endpoints, not `?format=csv`.** The JSON routes declare typed
   response schemas that cannot also return a CSV body, so each exportable view gets
   an `/export` sibling: `GET /cases/export`, `GET /audit/export`,
   `GET /reports/<name>/export`. Same query params and same visibility as the JSON
   route; pagination params are not accepted on export.
6. **Export row cap: 10 000 rows**, in memory (no streaming). When more rows match,
   the first 10 000 are returned and the response carries `X-Export-Truncated: true`
   (plus `X-Export-Total: <n>`); otherwise `X-Export-Truncated: false`.
7. **CSV format:** UTF-8 with BOM (so Excel shows Arabic correctly), CRLF line ends,
   RFC 4180 quoting. A cell whose first character is `=`, `+`, `-`, `@`, tab or CR is
   prefixed with `'` to neutralise spreadsheet formula injection. Dates are ISO 8601.
   `Content-Type: text/csv; charset=utf-8`,
   `Content-Disposition: attachment; filename="<name>-<YYYYMMDD>.csv"`.
8. **Exports are not audited** (consistent with reads and with notifications).
9. **No schema change, no migration.** Aggregations run on existing tables; add an
   index only if a test or `EXPLAIN` shows a need (record it as a ruling).
10. **Report date range** = `createdFrom` / `createdTo` on `cases.createdAt`
    (inclusive on both ends; callers send full ISO timestamps). Reports also accept the existing case filters (status, priority,
    category, type, entity, business unit, department, assignee). The dashboard takes
    no filters.

## 3. Structure

```
src/modules/dashboards-reports/
  dashboard.service.ts      # tiles, status counts, role panels
  dashboard.routes.ts       # GET /dashboard
  reports.service.ts        # the five report queries
  reports.routes.ts         # GET /reports/<name>, GET /reports/<name>/export
  reports.schemas.ts        # query + response Zod schemas
  csv.ts                    # toCsv(rows, columns), cell sanitising, BOM, headers
src/modules/cases/cases.service.ts   # extract applyCaseFilters(); add `open` filter
src/modules/cases/cases.routes.ts    # GET /cases/export
src/modules/audit/audit.routes.ts    # GET /audit/export
```

`applyCaseFilters(qb, actor, query)` is extracted from `listCases` unchanged (alias
`c`, never `case`); `listCases`, the case export, the dashboard and the reports all
use it, so SLA states and filters can never drift between screen, export and report.
Cross-module calls go through exported service functions per the parent spec.

## 4. Dashboard — `GET /dashboard`

Any authenticated role. Response:

```
{
  tiles: {
    total, open, awaitingAcceptance, waitingOnInput, overdue, onTime, closed  // numbers
  },
  filters: {           // the GET /cases query that reproduces each tile (UI-10/11)
    total: {}, open: {open:true}, awaitingAcceptance: {status:'Assigned'},
    waitingOnInput: {status:'Waiting on Input'},
    overdue: {open:true, slaState:'breached'}, closed: {status:'Closed'}
    // onTime has no filter (it is total minus overdue); not clickable
  },
  byStatus: [{ status, count }],        // all five statuses, zeros included, fixed order
  myAssignedCases?: [ ... ],            // legal_rep only (DR-04)
  managerPanels?: {                     // legal_manager and admin only (DR-05)
    openCaseloadByRep: [{ legalRepId, fullName, openCount, overdueCount }],
    unassigned:         { count, items: [...] },   // status Submitted
    awaitingAcceptance: { count, items: [...] }    // status Assigned
  }
}
```

Panel `items` hold at most 20 cases, oldest first, each
`{ id, referenceNumber, title, priority, status, resolutionDueAt, slaState }`.
`myAssignedCases` = the rep's own cases awaiting acceptance (status Assigned), same
shape; accept/reject use the existing endpoints. Viewers get tiles and chart only.
Every count is computed over the role scope of assumption 1.

## 5. Reports

All `GET`, auth required, roles `admin | legal_manager | viewer` (others 403). Each
has an `/export` sibling returning CSV with a header row.

| Route | Rows |
|---|---|
| `/reports/sla-compliance` | One object: `closedOnTime, closedLate, openOnTrack, openAtRisk, openBreached, compliancePercent` |
| `/reports/volume-by-category` | `{ categoryId, categoryName, caseTypeId, caseTypeName, count }` per category+type |
| `/reports/volume-by-organisation` | `{ entityId, entityName, businessUnitId, businessUnitName, departmentId, departmentName, count }` per entity+BU+department (BU nullable) |
| `/reports/ageing` | `[{ bucket: '0-7'|'8-30'|'31-90'|'91+', count }]` — all four buckets, zeros included |
| `/reports/rep-workload` | `{ legalRepId, fullName, openCount, awaitingAcceptanceCount, overdueCount }` per rep with at least one open case; unassigned cases are not a row |

Rows are ordered deterministically (counts descending, then name) so exports are
reproducible. Names come from master data, joined at query time (no copies).
Report rows that list cases (none do today) must carry `slaState` (DR-08); the
case-repository export includes `slaState` and `caseAgeHours` columns.

## 6. Case list changes

- New optional boolean query param `open` on `GET /cases` (and `/cases/export`):
  `true` → status ≠ Closed; omitting it changes nothing (all cases, as today). Needed so the Open and Overdue tiles are reproducible.
- `GET /cases/export`: all current list filters, no pagination; scoped exactly like
  `GET /cases` (a requester only exports cases they can see). Columns: referenceNumber,
  title, status, priority, categoryId, caseTypeId, entityId, businessUnitId,
  departmentId, assignedLegalRepId, requesterId, createdAt, ackDueAt,
  resolutionDueAt, closedAt, slaState, caseAgeHours, isEscalated. The case
  description is **not** exported.
- `GET /audit/export`: `admin | legal_manager` only; same filters as `GET /audit`
  (actorId, action, caseId); columns id, caseId, actorId, action, createdAt,
  beforeValue and afterValue as compact JSON strings.

## 7. Error handling

- Unauthenticated → 401; wrong role → 403 (existing handler shape).
- Invalid query (bad UUID, bad date, `createdFrom` after `createdTo`) → 400.
- Export over the cap is not an error (§2.6). No new error classes.

## 8. Testing

Integration tests per route against the real test database, seeding per test via
`resetDatabase` and existing fixtures (add small report fixtures if needed).

- Dashboard: every tile and each status count against a seeded mix (all statuses,
  open-overdue vs closed-late vs on time); zero cases returns all zeros and all five
  statuses; scope per role (requester department/responder rule, rep own cases,
  manager/admin/viewer all); panels only for the right roles; panel cap 20 and order.
- Overdue boundaries: due exactly now, one second ago, closed-late not counted as
  overdue; `filters` replay through `GET /cases` returns the same counts as the tiles.
- Reports: each aggregate against seeded data; filters and date range narrow results;
  empty result shapes (all buckets present, `compliancePercent` null); rep workload
  excludes unassigned and counts overdue; viewer allowed, legal_rep/requester 403.
- CSV: BOM, header, CRLF, quoting of commas/quotes/newlines, Arabic text intact,
  formula-injection prefixing (`=cmd|...`, `+1`, `-1`, `@x`), export caps at 10 000
  with truncation headers (use a lowered cap injected for the test), disposition
  filename, same rows as the JSON route for the same filters, requester export limited
  to visible cases, audit export role gate.
- Regression: existing `GET /cases` and `GET /audit` behaviour and responses are
  unchanged (full existing suite stays green); `open` filter combinations.

## 9. Review focus

- Counts must agree between tile, chart, `GET /cases` filter replay and CSV for the
  same role (single shared filter function).
- A requester must never see counts or export rows for cases outside their scope.
- CSV cells starting with `=`, `+`, `-`, `@` must never reach a spreadsheet as a
  formula; Arabic text and embedded newlines must round-trip.
- A large result must not exhaust memory or time out unexpectedly: the cap is
  enforced in the query (LIMIT), not after loading all rows.
- A case closed late must not appear as overdue; an open case exactly at its due
  time follows the strict `<` rule.

## 10. Traceability

DR-01 role-scoped `GET /dashboard`; DR-02 `tiles`; DR-03 `byStatus`; DR-04
`myAssignedCases`; DR-05 `managerPanels`; DR-06 five reports; DR-07 all `/export`
routes; DR-08 `slaState` in listings and case export; PR-32/AC-05 viewer read access
to dashboard, repository and reports; PR-34 viewer report export; UI-08..11 tiles,
chart, `filters`, shared filter logic; AT-04 `GET /audit/export`; NF-01 aggregate
queries over indexed columns.
