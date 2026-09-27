# Algihaz LCMS Backend — Design Spec

Status: Approved for planning
Date: 2026-09-27
Source requirements: `20260823_Legal Case Management System - requirement vdraft2.0 (1).pdf` (BRD v1.0)

## 1. Purpose & scope

Backend API for the Algihaz Legal Case Management System (LCMS). Serves a React
frontend (built separately, out of scope here). Covers: case intake and lifecycle
workflow, information-request sub-workflow, role-based access control, admin-configurable
master data, document storage, notifications (email + in-app), SLA computation and
breach detection, audit trail, and dashboards/reporting data.

Out of scope for this spec: the frontend, and the three integration reviews (AU-15
Baladi Violation app, AU-16 Najiz platform, AU-17 Oracle ERP/Article 80) — these are
explicitly "review feasibility" items in the BRD, not build items, and will be scoped
separately once findings are in.

## 2. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js LTS (22.x) + TypeScript |
| HTTP framework | Fastify |
| Validation | Zod + `fastify-type-provider-zod` (request/response schemas, inferred types, auto OpenAPI) |
| ORM / DB | TypeORM + PostgreSQL, migrations committed to repo |
| Object storage | S3-compatible client (`@aws-sdk/client-s3`); MinIO in dev, S3 in prod |
| Email | Nodemailer over SMTP (config-driven host/port/creds); MailHog in dev |
| Scheduled jobs | `node-cron`, in-process (SLA breach scan) |
| Auth | JWT access token (~15 min) + rotated refresh token (hashed at rest, revocable); bcrypt/argon2 password hashing |
| Package manager | pnpm |
| Testing | Vitest; integration tests run against a real Postgres via `docker-compose.test.yml` and Fastify `.inject()` |
| Dev infra | `docker-compose.dev.yml`: Postgres, MinIO, MailHog |

## 3. Architecture

**Feature-based modular monolith.** One Fastify app; each domain is a self-contained
Fastify plugin (routes + Zod schemas + service + repository/entities), registered with
Fastify's own encapsulation so a module's internals can't be reached except through its
exported service functions.

```
src/
  app.ts                    # Fastify instance assembly, plugin registration
  server.ts                 # entrypoint, graceful shutdown
  config/                   # env parsing/validation (zod), typed config object
  db/
    data-source.ts          # TypeORM DataSource
    migrations/
  plugins/                  # cross-cutting Fastify plugins (not domain-specific)
    auth.ts                 # JWT verify decorator -> request.user
    error-handler.ts        # centralized error -> HTTP response mapping
  modules/
    auth/                   # login, refresh, logout
    users/                  # admin user CRUD, role assignment, activation state
    master-data/            # categories, case-types, entities/BUs, departments,
                             # closure outcomes, routing rules
    cases/                  # intake, repository/listing, status transitions,
                             # assignment, escalation, closure
      entities/
      state-machine.ts      # explicit status transition table
    information-requests/   # raise / respond / reopen sub-workflow
    documents/               # upload, download/preview via S3, metadata
    notifications/           # in-app notification centre + email dispatch
    audit/                   # append-only audit log read/write
    dashboards-reports/      # DR-* aggregation endpoints, CSV export
    sla/                     # SLA calculation + node-cron breach-scan job
  shared/
    errors.ts                # typed AppError classes
    pagination.ts
    rbac.ts                  # role/permission helper functions
test/
  integration/
  unit/
docker-compose.dev.yml
docker-compose.test.yml
.env.example
```

Cross-module calls always go through a module's exported service functions (e.g.
`information-requests` triggers a case status change by calling into `cases`' service,
never by writing to the case table directly).

## 4. Data model

### 4.1 Identity & RBAC
- **users** — fullName, email (unique), passwordHash, designation, contact details,
  departmentId, entityId, businessUnitId, isActive, timestamps. No role column.
- **roles** — the 5 fixed roles (admin, legal_manager, legal_rep, requester, viewer).
- **user_roles** — one row per user, `userId` UNIQUE, FK `roleId`, assignedBy, assignedAt.
  Only the `users` module writes to this table. New users default to `requester`
  (PR-31); admin changes it. Unique constraint on `userId` enforces VC-16 (one active
  role per user) at the DB level.
- **refresh_tokens** — userId, tokenHash, expiresAt, revokedAt (nullable).

### 4.2 Org & master data (admin-configurable, DM-*)
- **entities**, **business_units** (BU belongs to entity). "Holding" is a constant,
  not a table (single holding company).
- **departments**
- **case_categories** — seeded with Najiz, Baladi Violation, HR Termination, Internal;
  admin-extensible.
- **case_types** — belongs to a category; carries `sla_ack_hours`, `sla_resolution_hours`,
  description.
- **closure_outcomes**
- **routing_rules** — match criteria (category/type/entity/BU/department/priority) as
  JSONB, target legal rep FK, priority order, isActive.

All master-data tables are plain admin-CRUD; changes are effective immediately (DM-09)
since nothing caches them beyond request scope.

### 4.3 Case core
- **cases** — referenceNumber (unique, immutable; generator isolated behind one
  function — exact format TBD, see §9), title, description (min 20 chars, VC-02),
  categoryId, caseTypeId, departmentId, entityId, businessUnitId (nullable), priority
  (default P3), `status` (enum: Submitted, Assigned, In Progress, Waiting on Input,
  Closed — changed only via state-machine service functions, never a raw update),
  `is_escalated` + `escalation_reason`, `waiting_on_reason`, requesterId,
  assignedLegalRepId (nullable), assignmentAcceptedAt (nullable), ackDueAt,
  resolutionDueAt, `sla_breach_notified_at` (nullable — idempotency guard for the
  breach-notification job), closureSummary, closureOutcomeId, closedById, closedAt,
  timestamps.
- SLA state (on track / at risk / breached / met) is **derived live** from due dates
  on read — not a stored column — so it's never stale between cron runs.

### 4.4 Information requests (sub-workflow)
- **information_requests** — caseId, subject/requirement description, raisedById
  (accepting lawyer), responderId, dueDate (nullable), status (open/answered/superseded),
  responseText (nullable), `reopened_from_id` (nullable self-FK).
- Reopening (WF-09) never mutates a row in place: the current row is marked
  `superseded`, a new row is created with `reopened_from_id` pointing at it, preserving
  full round-by-round history per case.
- **information_request_attachments** — join table to `documents`.

### 4.5 Documents & comments
- **documents** — s3Key, filename, mimeType, sizeBytes, category, version, uploaderId,
  caseId (nullable if attached via an information request instead).
- **comments** — caseId, authorId, body, `is_internal` (legal-only note vs
  requester-visible, UI-17/AC-10).

### 4.6 Audit & notifications
- **audit_log** — actorId, action, beforeValue (JSONB, nullable), afterValue (JSONB,
  nullable), caseId (nullable — system-wide entries have no case), createdAt.
  Append-only by convention: no update/delete code path exists anywhere in the app for
  this table (AT-05 enforced at the application layer, not via DB grants).
- **notifications** — userId, type, title, body, relatedCaseId (nullable), isRead,
  createdAt.

## 5. Auth, RBAC & error handling

- `POST /auth/login` verifies credentials, issues access JWT (15 min) + refresh token
  (rotated on use, hashed at rest, revocable via `revokedAt`).
- A Fastify `preHandler` verifies the access JWT and decorates
  `request.user = { id, role, departmentId, entityId, businessUnitId }`.
- Endpoint-level role gating uses a small `requireRole([...])` preHandler.
  Resource-level scoping (e.g. "requester sees only their department's cases", AC-04)
  is enforced **inside each module's service/repository query** — this is the chosen
  reading of AC-03's "database layer" requirement: never trust the client, always
  filter server-side in data-access code, rather than literal Postgres RLS policies.
- Errors are typed (`NotFoundError`, `ForbiddenError`, `ValidationError`,
  `ConflictError`, `UnauthorizedError`), thrown from services, and caught by one
  Fastify `setErrorHandler` that maps each to the right HTTP status and a consistent
  body: `{ error: { code, message, details? } }`. Zod validation failures produce the
  same shape. Unexpected errors are logged in full server-side; the client gets a
  generic 500 with no internal detail leaked.
- Audit logging is **explicit**: each mutating service function ends with a call to
  the `audit` module's log function, naming the action and before/after values. This
  keeps the log-write visible next to the business logic that caused it, at the cost
  of relying on each new mutation remembering to add the call (accepted trade-off —
  see §9).

## 6. Case workflow engine

- Status changes only happen through named service functions in the `cases` module
  (`assignCase`, `acceptAssignment`, `rejectAssignment`, `raiseInformationRequest`,
  `closeCase`, ...), each of which checks the transition table in `state-machine.ts`
  before applying it. There is no generic "update status" endpoint. This satisfies
  WF-13/VC-14 by construction.
- **Assignment:** `assignCase` (legal_manager/admin, or auto-routing) → Assigned,
  notifies assignee (PR-19, AU-05). `acceptAssignment` → In Progress, stamps acceptance
  time (WF-05, AU-06). `rejectAssignment` (reason ≥ 3 chars, VC-08) → Submitted,
  unassigned, notifies legal manager (WF-06, AU-07).
- **Manager reassignment (PR-23):** resets acceptance — reassigning a case always sets
  it to Assigned (pending acceptance) for the new lawyer, regardless of the case's
  current status, since the new lawyer hasn't agreed to take it on yet.
- **Information requests:** `raiseInformationRequest` (only the accepting lawyer,
  AC-14) → case status → Waiting on Input (WF-07). `respondToInformationRequest`
  (only the assigned responder) marks it answered; if no other open requests remain
  on the case, auto-transitions back to In Progress (WF-08). `reopenInformationRequest`
  (only the raising lawyer, mandatory comment, VC-11) creates the new history round
  and forces status back to Waiting on Input (WF-09) even if other requests were
  already answered.
- **Escalation** is a boolean + reason on the case row (WF-03/PR-15), toggled
  independent of status.
- **Closure:** `closeCase` validates no open information requests (VC-12/WF-10),
  summary text present, outcome selected from the master list, optional documents.
  Requires an explicit `confirm: true` in the request body (server-side backstop for
  the two-step UI confirmation, VC-13/WF-12).
- **Auto-routing (AU-04):** on submission, `routing_rules` are evaluated in priority
  order against category/type/entity/BU/department/priority; first match auto-assigns
  via the same `assignCase` path used for manual assignment. No match leaves the case
  in Submitted for manual assignment.
- **SLA:** on submission, `ackDueAt`/`resolutionDueAt` are computed from the case
  type's configured SLA hours (AU-03). SLA state is derived live on read. The `sla`
  module's cron job (every ~10 min) scans open cases for newly-breached ones
  (`sla_breach_notified_at IS NULL AND resolutionDueAt < now()`), notifies the legal
  manager (NT-03), and stamps that field so the notification fires exactly once.

## 7. Cross-cutting concerns

- **Documents:** multipart upload streams directly to S3/MinIO (never touches local
  disk); mime type and max size are validated before the upload proceeds (VC-15).
  Download/preview goes through `GET /documents/:id/download`, which checks the
  caller's entitlement to the parent case before streaming from S3 — no
  client-facing presigned URLs, so access control stays enforceable in code (AC-11).
- **Notifications:** each triggering event (assignment, rejection, info request
  raised/answered/reopened, closure, SLA breach) goes through one `notifications`
  module function per event type that writes both the in-app row and queues the
  email, so the two channels never drift out of sync. `GET /notifications`
  (paginated, filterable by read state) and `PATCH /notifications/:id/read` back the
  frontend's poll-based bell (no websockets in v1).
- **Dashboards & reports:** aggregation queries (counts by status, SLA compliance,
  ageing, workload by rep) live in their own `dashboards-reports` module, kept
  separate from `cases` so that module doesn't accumulate reporting-specific query
  complexity. List/report endpoints support CSV export (DR-07).
- **API conventions:** REST + JSON, offset/limit pagination with total count,
  consistent filter query params (status, priority, category, type, entity, BU,
  department, assignee, free-text search) shared across repository and report
  endpoints.
- **Config:** `.env` validated at startup via a Zod schema; the app refuses to boot
  on missing/invalid config rather than failing later at first use.

## 8. Non-functional

- All authorization checks happen server-side regardless of what the UI hides
  (UI-03/AC-03).
- Passwords hashed (bcrypt/argon2), never logged; JWTs signed with a rotated secret
  from config.
- File type/size validated on upload; documents accessible only to entitled users.
- Migrations are the only way schema changes reach any environment — no
  `synchronize: true` outside a throwaway local sandbox.

## 9. Open items / deferred decisions

- **Case reference number format** (VC-06/AU-01): exact `Group-Entity-Type-Reference ID`
  scheme is pending from Algihaz. The generator is implemented as one isolated,
  swappable function so the final format can drop in without touching call sites.
  Placeholder for initial build: `{EntityCode}-{CaseTypeCode}-{sequence:6}` (e.g.
  `AGC-NJZ-000123`), globally sequential.
- **AU-15/16/17** (Baladi Violation, Najiz, Oracle ERP integrations) are review/
  feasibility items in the BRD, not implementation scope for this spec. To be
  scoped separately once findings exist.
- Audit-log immutability (AT-05) is enforced at the application layer only (no DB
  grant revocation) per explicit decision — accepted risk: a direct DB session under
  the app's credentials could bypass it.
- Audit logging is explicit-call-based, not automatic via subscribers — accepted
  risk: a new mutation could be added without its audit call; code review is the
  mitigating control.

## 10. Requirement traceability (spot-check)

This design addresses all BRD sections: WF-01..14 (§6), PR-01..34 (§5, §6, RBAC in
§5), UI-01..18 (frontend, not built here, but API shapes support them — e.g. UI-05
"list exactly which requirements are outstanding" is satisfied by Zod validation
error details), AC-01..15 (§5), VC-01..18 (§4, §6), AU-01..17 (§6, §7, §9), DM-01..09
(§4.2), DR-01..08 (§7), AT-01..05 (§4.6, §9), NT-01..05 (§7), SE-01..04 (§5, §7, §8),
NF-01..04 (§2 architecture supports horizontal scaling; stack choices are all
config-driven for portability).
