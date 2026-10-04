# Information Requests — Design Spec

Status: Approved for planning
Date: 2026-10-04
Parent spec: `docs/superpowers/specs/2026-09-27-lcms-backend-design.md`
Source requirements: `20260823_Legal Case Management System - requirement vdraft2.0 (1).pdf` (BRD v1.0)

## 1. Purpose & scope

Second sub-project of Phase 2 (case workflow), building on case core
(sub-project 1). Implements the information-request sub-workflow: a legal
rep raising a question on a case they're working, routing it to a
responder, the responder answering, and the rep reopening an unsatisfactory
answer — the round-trip described in WF-07..09.

In scope: the `information_requests` entity, raise/respond/reopen, the case
status transitions this workflow drives (into and out of `Waiting on
Input`), the visibility extension this creates for requesters, and wiring
case core's previously-deferred closure guard (VC-12).

Out of scope (deferred): attachments on information requests (needs the
`documents` module, sub-project 3 — the parent spec's
`information_request_attachments` join table is not built here), and any
due-date automation (no breach notification exists in the BRD for this
field; it is stored and otherwise inert).

## 2. Data model — `information_requests`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| caseId | uuid FK → cases | |
| subject | varchar | |
| requirementDescription | text | VC-09; on a reopened row, this is the mandatory "what's still needed" comment (VC-11/WF-09) — see §4 |
| raisedById | uuid FK → users | the accepting legal_rep who raised it (AC-14) |
| responderId | uuid FK → users | any active user, any role (PR-11, literal BRD reading — no role restriction) |
| dueDate | timestamptz, nullable | VC-09 "where applicable"; stored only, no automation |
| status | varchar | `open` \| `answered` \| `superseded` |
| responseText | text, nullable | set on answer (VC-10) |
| reopenedFromId | uuid FK → information_requests, nullable | self-FK, points at the row this one supersedes |
| createdAt / updatedAt | timestamptz | |

No `information_request_attachments` table in this sub-project.

## 3. Authorization (all literal BRD reads, no extensions)

- **Raise** (`POST /cases/:id/information-requests`): only the case's
  `assignedLegalRepId`, and only while the case is `In Progress` (i.e.
  accepted) — AC-14/PR-10. No legal_manager/admin override (unlike
  escalation in case core, which was deliberately widened; this one
  wasn't).
- **Respond** (`POST /information-requests/:id/respond`): only
  `request.responderId` — AC-15.
- **Reopen** (`POST /information-requests/:id/reopen`): only
  `request.raisedById` (the original raiser, not whoever raised the latest
  round if different — though in practice it's always the same person
  since only one legal_rep can be assigned to a case at a time) — AC-15.
- **List/read**: scoped like the parent case (see §5).

## 4. Core functions & state-machine integration

This sub-project is the first caller of the `Waiting on Input` transitions
case core's `state-machine.ts` already defines but never exercises
(`'In Progress' → 'Waiting on Input'`, `'Waiting on Input' → 'In
Progress'`). Every status change on the case goes through case core's
transition function, never a raw write, per the parent spec's cross-module
rule (§3).

- `raiseInformationRequest(dataSource, actorId, caseId, input: {subject, requirementDescription, responderId, dueDate?})` —
  validates actor is the assigned+accepted rep (`ForbiddenError` otherwise),
  case status is `In Progress` **or already `Waiting on Input`**
  (`ConflictError` for any other status). Multiple concurrent open
  requests on one case are explicitly allowed — WF-08 says the case
  returns to `In Progress` only when *every* open request is answered,
  which presupposes more than one can be open at once. `responderId`
  references a real active user (`ValidationError` otherwise, no role
  check). Creates the row (`status: open`); transitions the case to
  `Waiting on Input` only if it isn't already there (a no-op on status
  when raising a second concurrent request — the state machine has no
  `'Waiting on Input' → 'Waiting on Input'` self-edge, so this is a plain
  status check in the service, not a transition call, when already in
  that state). Audits `info_request.raised`.
- `respondToInformationRequest(dataSource, actorId, requestId, responseText)` —
  validates actor is `responderId`. Sets `status: answered`,
  `responseText`. Queries whether any other `open` request exists for the
  same `caseId`; if none, transitions the case back to `In Progress`
  (WF-08/AU-09) — if other open requests remain, the case stays in
  `Waiting on Input`. Audits `info_request.answered`.
- `reopenInformationRequest(dataSource, actorId, requestId, comment)` —
  validates actor is `raisedById` and the target row's `status` is
  `answered` (reopening an already-`open` or already-`superseded` row is
  invalid — `ConflictError`). Marks the current row `superseded`, creates a
  new row with `reopenedFromId` pointing at the superseded row,
  `requirementDescription: comment`, `status: open`, same `responderId`
  (carried over — BRD doesn't say reopening can retarget the responder).
  Forces the case to `Waiting on Input` (WF-09) even if other requests on
  the case are already answered — this is an unconditional transition, not
  gated on "any open requests" like the respond path. Audits
  `info_request.reopened`.

## 5. Visibility extension (back into case core)

AC-04: a `requester` sees their own department's cases **plus** cases
where an information request is assigned to them. This sub-project adds an
OR-clause to case core's `listCases`/`getCaseById`
(`src/modules/cases/cases.service.ts`): a requester additionally sees any
case that has an `information_requests` row with `responderId =
actor.id` (any status — once they've been a responder, they keep
visibility into that case's history). This is a real edit to
already-shipped case-core code, not a clean sub-project boundary; flagged
explicitly since it crosses sub-projects.

No other role's visibility changes — legal_rep/legal_manager/admin/viewer
already see all cases.

## 6. Closure guard (wiring case core's deferred VC-12)

Case core's `closeCase` (`src/modules/cases/cases.workflow.service.ts`)
currently has no "no open information requests" guard — explicitly
deferred in case core's own spec §8. This sub-project adds it: before
transitioning to `Closed`, query for any `information_requests` row with
`caseId` matching and `status = 'open'`; if any exist, reject with
`ConflictError` (VC-12/WF-10).

## 7. Endpoints

- `POST /cases/:id/information-requests` — raise. `requireRole(['legal_rep'])`
  at the route (service layer further restricts to the specific assigned
  rep).
- `GET /cases/:id/information-requests` — list for a case, scoped like the
  parent case's visibility.
- `POST /information-requests/:id/respond` — respond. Any authenticated
  role at the route (service layer restricts to the specific responder,
  since a responder can hold any role per §3).
- `POST /information-requests/:id/reopen` — reopen. `requireRole(['legal_rep'])`
  at the route (service layer restricts to the specific raiser).

## 8. Audit logging

`info_request.raised`, `info_request.answered`, `info_request.reopened` —
each with before/after values including `id`, `caseId`, and
`referenceNumber` (the case's), matching the convention established in
case core.

## 9. Deferred to later Phase 2 sub-projects

- Attachments on information requests and their responses — sub-project 3
  (documents).
- Notification dispatch on raise/respond/reopen (NT-04 etc.) — sub-project
  4, same no-op-for-now pattern as case core.
- Any due-date-driven automation — not specified anywhere in the BRD for
  this entity; stays inert.

## 10. Testing

- Integration tests per endpoint: happy path, role/ownership rejection,
  invalid-state rejection (raising on a non-In-Progress case, responding
  to an already-answered request, reopening an `open` or `superseded`
  request).
- State-machine integration tests: raising moves the case to `Waiting on
  Input`; responding to the only open request moves it back to `In
  Progress`; responding while another request is still open leaves it in
  `Waiting on Input`; reopening forces `Waiting on Input` even when other
  requests are already answered.
- Visibility test: a requester who is a responder on an information
  request can see the parent case even though it's outside their
  department.
- Closure guard test: `closeCase` rejects a case with an open information
  request (VC-12), and the existing case-core closure tests still pass
  with no open requests present.

## 11. Requirement traceability (spot-check)

WF-07..09 (§4), AC-14/15 (§3), VC-09..12 (§2, §6), AU-08/09 (§4), PR-10..12
(§3, §4). PR-04/05 (requester-side visibility/response, §5, §7). NT-04
remains deferred to sub-project 4 per §9.
