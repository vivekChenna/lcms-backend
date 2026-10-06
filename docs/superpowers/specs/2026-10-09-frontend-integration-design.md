# Frontend Integration Readiness — Design Spec

Status: Draft for review
Date: 2026-10-09
Parent spec: `2026-09-27-lcms-backend-design.md`
Related notes: `docs/frontend-reference/lovable-prototype-notes.md`, `docs/frontend-reference/frontend-skeleton-and-gap-analysis.md`
Source requirements: BRD v1.0 — AC-01..05, PR-02/03/09, DR-01..08, AT-01..05, NT-01..05, UI-12, VC-01..04

## 1. Purpose & scope

The React frontend (own design, shadcn/ui + lucide-react, TanStack Router + TanStack Query, English only, tokens in cookies) must talk to this API from a browser. This work closes the gaps found when comparing the manager's reference prototype and the frontend skeleton with the backend. Nothing here changes the five-status workflow.

In scope:

1. **Cookie authentication, CORS and CSRF protection**, plus `GET /auth/me` (§3).
2. **Names on responses** — cases, comments, information requests, documents, notifications, audit rows, dashboard panels, exports (§4).
3. **Extra intake fields and a confidential flag**, with confidential-case visibility enforced everywhere (§5).
4. **Dashboard changes** for legal reps and new tiles (§6).
5. **Case-scoped audit endpoint** readable by any role that can see the case (§7).
6. **"Mark all notifications read"** (§8).
7. **Audit coverage guard** — a test-only safety net that fails when a mutating endpoint forgets its audit entry (§8a).

Out of scope (deferred, listed in §11): the "waiting on" reason endpoint, priority-based SLA targets, the closure-outcome "needs detail" flag, a "who can raise this category" setting, extra dashboard widgets (requests by department, performance block), manager rejection of a request at Submitted, the prototype's seven-status model.

## 2. Decisions & assumptions

Answered by the project owner:

- Follow the BRD: five statuses (WF-02); Reports for admin, legal manager, viewer; Audit for admin and legal manager only; accept/reject on the dashboard is a frontend job (backend already supports it).
- A legal rep's dashboard shows organisation-wide tiles plus "assigned to me" and "my cases".
- Add the extra intake fields as optional columns in one migration, plus the confidential flag.
- Add a read-only case-scoped audit endpoint for every role that can see the case; the global audit stays admin / legal manager.
- Names are added to responses by the backend.
- **Confidential case visibility:** admin, legal manager and legal rep (AC-04), the requester who submitted it, and anyone an information request on it is assigned to. Other requesters in the department and **viewers** do not see it anywhere (lists, detail, dashboard, reports, exports).

Assumptions (BRD silent):

1. **Tokens stay in the JSON response too.** `POST /auth/login` and `/auth/refresh` still return `accessToken`/`refreshToken` in the body (Swagger, scripts and tests use them); the browser frontend must ignore them and rely on the cookies. `Authorization: Bearer` keeps working and takes precedence over the cookie.
2. **Cookies:** `lcms_access` (path `/`, max-age = access token lifetime, 15 min) and `lcms_refresh` (path `/auth`, max-age = refresh lifetime, 30 days), both `HttpOnly`, `SameSite=Lax` by default, `Secure` in production. Configured by `COOKIE_SECURE`, `COOKIE_SAMESITE` (`lax|strict|none`; `none` requires secure), `COOKIE_DOMAIN` (optional).
3. **CSRF rule:** a state-changing request (anything but GET/HEAD/OPTIONS) that carries one of our auth cookies and **no** `Authorization` header must have an `Origin` header in `CORS_ORIGINS`; otherwise 403 `CSRF_BLOCKED`. `SameSite=Lax` is the first line of defence, this is the second. The rule applies to `/auth/refresh` and `/auth/logout` too.
4. **CORS:** `CORS_ORIGINS` is a comma-separated allowlist (empty = CORS off, same-origin only); credentials allowed; `Access-Control-Expose-Headers` lists `Content-Disposition`, `X-Export-Total`, `X-Export-Truncated` so the browser can read CSV export headers.
5. **Names are visible to everyone who can see the record** (a requester sees the assigned rep's name; a viewer sees names). Names come from the current user row, not a snapshot. No new data is exposed that the role could not already see by id.
6. **Case audit for non-legal roles** (requester, viewer) hides rows that would leak legal-only content: any comment event whose `isInternal` is true, and `case.rejected` (the rep's written reason). Legal roles (admin, legal manager, legal rep) see every row of the case.
7. **Dashboard rep scope** changes to organisation-wide because legal reps can already read all cases (AC-04) and `GET /cases` is not scoped for them.

## 3. Cookie authentication, CORS, CSRF, `/auth/me`

New dependencies: `@fastify/cookie`, `@fastify/cors`.

**Config (`src/config/env.ts`)** — `CORS_ORIGINS` (string, default empty), `COOKIE_SECURE` (`true|false`, default `true` when `NODE_ENV=production`, else `false`), `COOKIE_SAMESITE` (default `lax`), `COOKIE_DOMAIN` (optional). `.env.example` documents them with the local frontend origin.

**Login (`POST /auth/login`)** — unchanged inputs and body, plus `Set-Cookie` for both cookies. The `user` object becomes the profile shape below.

**Refresh (`POST /auth/refresh`)** — body `refreshToken` becomes optional; when absent the `lcms_refresh` cookie is used. Rotation is unchanged. New cookies are set on success.

**Logout (`POST /auth/logout`)** — revokes the refresh token (body or cookie) as today and clears both cookies. It succeeds even if no token is present.

**Authentication (`authenticate`)** — token is read from `Authorization: Bearer` first, else from `lcms_access`. Everything after verification is unchanged (the user row is re-read on every request, deactivation and role changes take effect immediately).

**Profile — `GET /auth/me`** (any authenticated user) and the `user` object in the login/refresh responses:

```
{ id, fullName, email, designation, role,
  departmentId, departmentName, entityId, entityName, businessUnitId, businessUnitName }   // names nullable when the id is null
```

**CSRF hook** — an `onRequest` hook implementing assumption 3. It never blocks safe methods, requests with an `Authorization` header, or requests without our cookies.

## 4. Names on responses

All name lookups are **batched** per response (one query per kind of id, never per row).

| Response | New fields |
|---|---|
| Case (list, detail, update, assign/accept/reject/close results, case export) | `requesterName`, `requesterDesignation`, `assignedLegalRepName` (null when unassigned), `assignedLegalRepRole`, `categoryName`, `caseTypeName`, `departmentName`, `entityName`, `businessUnitName` (null when none) |
| Dashboard panel items | `assignedLegalRepName` |
| Comment | `authorName`, `authorRole` |
| Information request | `raisedByName`, `raisedByRole`, `responderName` |
| Document and document versions | `uploadedByName` |
| Notification | `relatedCaseReference` (null when no case) |
| Audit row (`GET /audit`, `GET /cases/:id/audit`, `GET /audit/export`) | `actorName`, `actorRole`, `caseReference` (null when no case) |

The CSV exports of cases and audit gain the same name columns after the existing id columns (ids stay, so existing consumers do not break).

Implementation: a small shared module `src/shared/name-lookup.ts` with `loadUserNames(source, ids)` → `Map<id, { fullName, designation, role }>` and `loadMasterNames(source, {...ids})`; services call it once after loading their page of rows. A user id whose row is missing yields `null` names, never an error.

## 5. Intake fields and the confidential flag

**Migration** — new nullable columns on `cases` (plus `isConfidential boolean NOT NULL default false`):

| Column | Type | Rules |
|---|---|---|
| `isConfidential` | boolean | default false |
| `contactName` | varchar(200) | |
| `contactEmail` | varchar(320) | valid email when present |
| `contactPhone` | varchar(50) | |
| `desiredOutcome` | text | max 5000 chars |
| `incidentDate` | date | ISO date |
| `businessDeadline` | date | ISO date |
| `counterparty` | varchar(300) | |
| `estimatedValue` | numeric(14,2) | ≥ 0 |
| `thirdPartyDetails` | text | max 5000 chars |

Accepted in `POST /cases` and (while the case is still Submitted, same rule as the other editable fields) `PATCH /cases/:id`; returned in every case response. The migration's `down()` drops them. `estimatedValue` is serialized as a number. Empty strings are treated as absent.

**Confidential visibility.** A case is visible to an actor unless it is confidential **and** the actor is:

- a **viewer**; or
- a **requester** who is neither the submitter (`requesterId`) nor the assigned responder of an information request on that case.

Legal roles (admin, legal manager, legal rep) always see it. For a requester the existing department rule becomes: visible if *(same department and not confidential)* or *submitter* or *information-request responder*.

This is enforced at the existing choke points so every consumer inherits it: `applyCaseFilters` (list, export, dashboard counts and panels, all reports) and the single-case visibility check used by `getCaseById` (and therefore detail, comments, documents, information requests and the new case audit endpoint, which all call it first). Hidden cases answer 404, like cases in other departments today.

Consequences to pin in tests: a viewer's dashboard counts, report counts and CSV exports exclude confidential cases; a requester in the same department who is not the submitter sees none of it; the submitter and an information-request responder still do. Notifications are unaffected (they go to the people already involved).

## 6. Dashboard changes

- `tiles` gains `assignedToMe` (open cases assigned to the caller; 0 for roles that cannot be assigned) and `unassigned` (status Submitted). Existing tiles unchanged.
- `filters` gains `assignedToMe: { open: 'true', assignedLegalRepId: <caller id> }` and `unassigned: { status: 'Submitted' }`.
- **Legal rep scope becomes organisation-wide** (the "assigned to me" tile and panel carry the personal view). The per-rep tile-filter workaround added in the review of sub-project 6 is removed because tiles no longer need an assignee filter.
- `myAssignedCases` (legal rep only) now lists the rep's **open** cases (every non-Closed status), oldest first, at most 20, each item including `status` so the frontend can show Accept/Reject on `Assigned` ones. Panel items gain `assignedLegalRepName`.
- Requester scope, manager/admin panels and viewer behaviour are unchanged except for the confidential rule (§5).

## 7. Case-scoped audit — `GET /cases/:id/audit`

Any authenticated role that passes the case visibility check (§5) — including requester and viewer — gets a read-only, paginated (`page`, `pageSize`) list, newest first: `{ items: [{ id, action, actorId, actorName, actorRole, createdAt, beforeValue, afterValue }], total, page, pageSize }`. For requester and viewer, rows are filtered by assumption 6 (internal comment events and `case.rejected` removed, and `total` reflects the filtered count). No write access, no audit entry for the read. `GET /audit` and `GET /audit/export` stay admin / legal manager only.

## 8. Mark all notifications read

`PATCH /notifications/read-all` → marks every unread notification of the caller as read (`readAt` = now), returns `{ updated: <count> }`. Idempotent; other users' rows untouched. Registered so it cannot be mistaken for `PATCH /notifications/:id/read`.

## 8a. Audit coverage guard (test-only)

BRD AU-14/AT-01 require every business event to be audited, and audit calls are written by hand per action. To catch a forgotten call:

- **Manifest** — `test/integration/helpers/audit-manifest.ts` lists every mutating route (`POST`, `PATCH`, `PUT`, `DELETE`) as either **audited** (with the expected action name) or **exempt** (with a written reason). Exempt today: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/change-password` (authentication events are not in the BRD), `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` (read state, not a business event).
- **Completeness test** — `buildTestApp` records every mutating route registered; a test fails if a registered mutating route is in neither list, or a manifest entry no longer matches a route, or an exempt entry has no reason. A new endpoint therefore cannot ship unclassified.
- **Runtime check** — in the test app only (never in production code) an `onSend` hook counts `audit_log` rows before and after each mutating request that returns 2xx on a non-exempt route; if no row was added the response is replaced by a 500 `AUDIT_COVERAGE_MISSING`, so whichever existing test exercises that route fails loudly. A concurrent request can only hide a gap, never create a false failure.
- A route that legitimately writes no audit row on success is added to the exempt list with a reason, in the same commit.

## 9. Testing

Integration tests against the real test database, per route, using `resetDatabase` and existing fixtures:

- **Auth:** login sets both cookies with the right attributes and still returns tokens; a cookie alone authenticates; Authorization wins when both are present; refresh works from the cookie and rotates; replayed refresh token rejected; logout clears cookies and revokes; `GET /auth/me` shape for each role; CSRF: cookie-authenticated POST with a missing or foreign `Origin` → 403, with an allowed `Origin` → ok, Authorization-header requests and GETs never blocked; CORS preflight and `Access-Control-Expose-Headers` for allowed origins, none for others.
- **Names:** every response in §4 for each relevant role, missing user ids, no N+1 (assert query counts on the list endpoints).
- **Intake fields:** create and patch with each field; validation (bad email, negative value, bad date); fields returned; empty strings.
- **Confidential:** each actor type × list, detail, comments/documents/information-requests, dashboard, reports, case export, case audit — hidden for viewers and non-submitter requesters, visible for legal roles, the submitter and an information-request responder; unaffected non-confidential behaviour (full existing suite stays green).
- **Dashboard:** rep tiles org-wide, `assignedToMe`, `unassigned`, panel contents and order, filter replay for the new tiles through `GET /cases`.
- **Case audit:** every role, internal-comment and `case.rejected` rows hidden for requester/viewer and shown to legal roles, pagination, 404 for invisible cases.
- **Notifications:** mark-all-read counts and isolation.
- **Audit coverage guard:** the completeness test, plus a deliberate negative test (a throwaway route that mutates without auditing returns 500 `AUDIT_COVERAGE_MISSING`; one that audits passes).

## 10. Review focus

- A cookie-authenticated mutating request from a foreign origin must never succeed; Authorization-header and cookie-less requests must be unaffected.
- A viewer or an unrelated requester must never learn that a confidential case exists: not through a count, a report row, an export row, a name lookup, or a case audit entry.
- The case audit endpoint must not reveal internal legal notes or rejection reasons to requesters or viewers.
- Names must come from batched lookups and tolerate missing users.
- Every mutating route is classified in the audit manifest, and the existing suite passes with the runtime check on.
- Existing clients using `Authorization: Bearer` and the tokens in the login body must keep working.

## 11. Deferred

Waiting-on reason endpoint; priority SLA targets, closure-outcome "needs detail" flag and category "who can raise it" setting; dashboard widgets (requests by department, performance block, requires-attention list, escalated count); manager rejection at Submitted; any seven-status model; refresh-token cookie rotation hardening beyond the existing rotation; deployment decisions for cookie domain (the frontend and API must share a site for `SameSite` cookies — settings are env-driven so either layout works).

## 12. Traceability

AC-01..05 and PR-03 (confidential and scoping rules); PR-09 (dashboard panel supports accept/reject, §6); DR-01..05 (dashboard); AT-04 (audit and export names); PR-02 (profile names for prefill); UI-12 (filters unchanged); NT-01..05 (notifications unchanged, plus mark-all-read); VC-01..04 (validation unchanged, new fields optional).
