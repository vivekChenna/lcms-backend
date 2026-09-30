# Case Core — Design Spec

Status: Approved for planning
Date: 2026-10-01
Parent spec: `docs/superpowers/specs/2026-09-27-lcms-backend-design.md`
Source requirements: `20260823_Legal Case Management System - requirement vdraft2.0 (1).pdf` (BRD v1.0)

## 1. Purpose & scope

First sub-project of Phase 2 (case workflow). Everything else in Phase 2 —
information requests, documents/comments, notifications, the SLA breach job,
dashboards/reports — builds on the `cases` module this spec defines, so it
ships first.

In scope: the `cases` entity, the status state machine, case submission,
listing/detail with role-scoped visibility, assignment/acceptance/rejection/
reassignment, escalation, priority changes, closure, auto-routing on submit,
and SLA due-date computation + live SLA-state derivation.

Out of scope (deferred to later Phase 2 sub-projects, each noted at the
relevant section below): information requests, document attachment,
comments, actual notification dispatch, the SLA breach cron job, and
dashboard/report aggregation.

## 2. Data model — `cases`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| referenceNumber | string, unique, immutable | Placeholder format `{EntityCode}-{CaseTypeCode}-{sequence:6}` (e.g. `AGC-NJZ-000123`), globally sequential. Real `Group-Entity-Type-Reference ID` format (VC-06/AU-01) pending from Algihaz — generator isolated behind one swappable function. |
| title | string | required |
| description | text | min 20 chars (VC-02) |
| declarationConfirmed | boolean | must be `true` at submission (VC-01) |
| categoryId | uuid FK → case_categories | |
| caseTypeId | uuid FK → case_types | must belong to `categoryId` (VC-04) |
| departmentId | uuid FK → departments | |
| entityId | uuid FK → entities | |
| businessUnitId | uuid FK → business_units, nullable | must belong to `entityId` if present (VC-05) |
| priority | enum P1–P4 | default P3 (VC-01) |
| status | enum | Submitted, Assigned, In Progress, Waiting on Input, Closed (WF-02) |
| isEscalated | boolean | default false (WF-03) |
| escalationReason | text, nullable | |
| waitingOnReason | text, nullable | column exists now; populated starting sub-project 2 |
| requesterId | uuid FK → users | who submitted |
| assignedLegalRepId | uuid FK → users, nullable | |
| assignmentAcceptedAt | timestamp, nullable | |
| ackDueAt | timestamp | computed on submit |
| resolutionDueAt | timestamp | computed on submit |
| slaBreachNotifiedAt | timestamp, nullable | idempotency guard for sub-project 5's cron job; column added now per the parent spec's §4.3 data model to avoid a later migration |
| closureSummary | text, nullable | |
| closureOutcomeId | uuid FK → closure_outcomes, nullable | |
| closedById | uuid FK → users, nullable | |
| closedAt | timestamp, nullable | |
| createdAt / updatedAt | timestamp | |

SLA state (on_track / at_risk / breached / met) and case age are **derived
live on read**, never stored — see §6.

## 3. State machine

Full lifecycle: `Submitted → Assigned → In Progress → Waiting on Input → Closed`
(WF-02, no duplicate/overlapping statuses). The complete transition table is
defined in `state-machine.ts` now — a state machine is only correct if it's
whole — but only the transitions this sub-project actually triggers get a
route/service function this round:

- `submitCase` → Submitted
- `assignCase` (manual: legal_manager/admin; or auto-routing on submit) → Assigned (WF-04)
- `acceptAssignment` (assigned legal_rep) → In Progress, stamps acceptance time (WF-05/AU-06)
- `rejectAssignment` (assigned legal_rep, reason ≥3 chars, VC-08) → Submitted, unassigned (WF-05/WF-06/AU-07)
- `reassignCase` (legal_manager/admin, any status except Closed, PR-23) → Assigned, resets acceptance
- `closeCase` (assigned legal_rep or legal_manager/admin; requires `confirm: true`, `closureSummary`, `closureOutcomeId`) → Closed (WF-11/WF-12/VC-13)

Waiting-on-Input transitions (`raiseInformationRequest` → Waiting on Input,
WF-07/AU-08; `respondToInformationRequest` → In Progress when no open
requests remain, WF-08/AU-09) exist in the transition table but have no
caller yet. Sub-project 2 calls into this module's transition function
rather than re-implementing the guard, per the parent spec's cross-module
rule (§3: "information-requests triggers a case status change by calling
into cases' service, never by writing to the case table directly").

`closeCase`'s "no open information requests" guard (VC-12) cannot be
enforced yet — the table doesn't exist. Sub-project 1 closes without that
check; sub-project 2 adds the one extra guard clause when it lands. Status
is never directly editable by any route (WF-13) — every change goes through
one of the named functions above, each validated against the transition
table (VC-14).

## 4. Visibility & authorization

| Role | Read | Write |
|---|---|---|
| admin | all cases | all actions |
| legal_manager | all cases (PR-17/AC-06) | assign/reassign/escalate/close any case, adjust priority anytime (PR-19/PR-23) |
| legal_rep | all cases (AC-05) | accept/reject/escalate/close/raise-info-request only on cases assigned to and accepted by them |
| requester | own department's cases (AC-04/PR-03); info-request-assignee visibility added in sub-project 2 | submit new cases (Internal category only, VC-03, server-side enforced); edit their own case while Submitted |
| viewer | all cases, read-only (AC-07/PR-32) | none |

`legal_rep` submitting a case (PR-16, any category) is treated as the
`requesterId` for that case and gets the same submitter edit rights as a
`requester` while it's Submitted.

## 5. Endpoints

All under `preHandler: [app.authenticate, requireRole([...])]` plus the
resource-level scoping from §4 enforced in the service layer (never trusting
the client, per the parent spec's AC-03 reading).

- `POST /cases` — requester/legal_rep/admin. Body: title, description,
  declarationConfirmed, categoryId, caseTypeId, departmentId, entityId,
  businessUnitId?, priority?. Requester's entityId/businessUnitId are
  pre-filled from their profile and not client-settable (PR-02). Stamps
  requesterId + submission timestamp (AU-02), generates referenceNumber,
  computes SLA due dates, runs auto-routing.
- `GET /cases` — filters: status, priority, category, type, entity, BU,
  department, assignee, search, slaState (UI-09/DR-08); scoped per §4.
- `GET /cases/:id` — scoped per §4.
- `PATCH /cases/:id` — submitter or admin, Submitted-status only; title,
  description, categoryId, caseTypeId, departmentId, priority — excludes
  entityId/businessUnitId (locked per PR-02).
- `PATCH /cases/:id/priority` — legal_manager/admin, any status except
  Closed (PR-19) — separate from the general edit above since it isn't
  Submitted-gated.
- `PATCH /cases/:id/assign` — legal_manager/admin, body targetLegalRepId
  (must hold legal_rep/legal_manager, VC-07).
- `PATCH /cases/:id/accept` — assigned legal_rep only.
- `PATCH /cases/:id/reject` — assigned legal_rep only, body reason (≥3 chars).
- `PATCH /cases/:id/reassign` — legal_manager/admin, body targetLegalRepId.
- `PATCH /cases/:id/escalate` — assigned legal_rep or legal_manager/admin,
  body reason; same route toggles off (isEscalated: false clears reason).
- `PATCH /cases/:id/close` — assigned legal_rep or legal_manager/admin, body
  confirm: true, closureSummary, closureOutcomeId.

## 6. Auto-routing & SLA

**Auto-routing (AU-04):** on submit, evaluate active `routing_rules`
(existing module from Phase 1) ordered by `priorityOrder` ascending. A rule
matches when every key present in its `matchCriteria` — `categoryId`,
`caseTypeId`, `entityId`, `businessUnitId`, `departmentId`, `priority` — equals
the case's corresponding value; a key absent from the rule is a wildcard.
First match auto-assigns via the same `assignCase` path used for manual
assignment (audited as `case.auto_assigned`, attributed to the submitter —
it's a direct synchronous consequence of their own submission call, so no
"system" pseudo-actor is needed). No match leaves the case in Submitted for
manual assignment.

**SLA (AU-03/AU-11):** on submit, `ackDueAt`/`resolutionDueAt` are computed
from the case type's configured `slaAckHours`/`slaResolutionHours`. State is
derived live on every read, never stored:
- `met` — closed before `resolutionDueAt`
- `breached` — past `resolutionDueAt` while open, or closed after it
- `at_risk` — open, and less than 20% of the total ack-to-resolution window
  remains (the BRD requires the state to exist, AU-11/DR-08, but specifies
  no numeric rule; percentage-of-window scales with each case type's own
  SLA length rather than one fixed hour count across very different SLA
  durations)
- `on_track` — otherwise

Case age is likewise derived (`createdAt` → `closedAt` or now).

## 7. Audit logging

Every mutating function ends with `logAuditEvent`, before/after values
including `id` and `referenceNumber` (matching the convention fixed in the
Phase 1 review pass): `case.submitted`, `case.assigned`, `case.auto_assigned`,
`case.accepted`, `case.rejected`, `case.reassigned`, `case.escalated`,
`case.escalation_cleared`, `case.priority_changed`, `case.updated`,
`case.closed`.

## 8. Deferred to later Phase 2 sub-projects

- `closeCase`'s open-information-request guard (VC-12) — sub-project 2
- `waitingOnReason` population and the Waiting-on-Input transitions — sub-project 2
- Document attachment at closure (WF-11) — sub-project 3
- Actual notification dispatch (AU-13, NT-01..05) — currently no-op call
  sites are NOT added in this sub-project (no consumer exists yet); sub-project 4
  adds the calls at each of the points listed in §7
- SLA breach cron job (the `sla_breach_notified_at` column exists; the scan
  that reads/writes it does not) — sub-project 5
- Dashboard/report aggregation reading this data — sub-project 6

## 9. Testing

- Integration tests per endpoint: happy path, role-rejection, invalid-status-transition rejection.
- Unit tests for the state-machine transition table itself (including the
  not-yet-wired Waiting-on-Input edges, so sub-project 2 inherits a verified
  table).
- Auto-routing matching tests: wildcard fields, priority-order tiebreak, no-match fallback.
- SLA derivation tests: boundary cases for on_track/at_risk/breached/met.
- Visibility tests per role: the 5-row matrix in §4, both listing and detail-get.

## 10. Requirement traceability (spot-check)

WF-01..06, WF-11..14 (§3, §5); PR-01..03, PR-08, PR-16, PR-17, PR-19, PR-23
(§4, §5); AC-04..07 (§4); VC-01..08, VC-13, VC-14 (§2, §3, §5); AU-01..07,
AU-11 (§6); AT-02 (§7). WF-07..10, AC-14/15, VC-09..12, AU-08/09,
PR-04/05/09..15, PR-20/21, DR-*, NT-*, AT-01/03/04 remain covered by later
Phase 2 sub-projects per §8.
