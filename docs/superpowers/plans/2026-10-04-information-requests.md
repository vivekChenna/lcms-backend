# Information Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the information-request sub-workflow — raise/respond/reopen — on top of case core, driving the `In Progress` ⇄ `Waiting on Input` transitions case core's state machine already defines but doesn't yet exercise.

**Architecture:** A new Fastify module `src/modules/information-requests/` (entity/schemas/service/routes), following the same pattern as `src/modules/cases/`. Case-status changes this module needs stay inside case core: two new functions, `markCaseWaitingOnInput`/`markCaseInProgress`, are added to the already-shipped `cases.workflow.service.ts`, and information-requests calls into them rather than writing `cases.status` directly — the parent spec's cross-module rule. The reverse direction (case core's visibility needing to know about information requests) is kept as a raw SQL fragment referencing the `information_requests` table by name, not a TypeScript import, so the two modules' service files don't form an import cycle.

**Tech Stack:** Fastify 5, TypeORM, Zod 4 + fastify-type-provider-zod, PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-information-requests-design.md`

## Global Constraints

- Schema changes only via committed migrations — never `synchronize: true`.
- `cases.status` is mutated only inside `cases.workflow.service.ts`, through functions validated against the state-machine transition table (`src/modules/cases/state-machine.ts`) — information-requests never writes to the `cases` table's `status` column directly, always calls `markCaseWaitingOnInput`/`markCaseInProgress`.
- All RBAC/visibility enforced server-side in the service layer, never trusted from the client.
- Every mutating function ends with a `logAuditEvent` call; before/after values include `id` and (where the entry is about a case) `referenceNumber`, matching the case-core convention.
- TDD: write the failing test before the implementation, for every task.
- A responder can hold **any** role, not just `requester` — PR-11's literal text ("any Algihaz employee/user"), no role restriction anywhere in this module.
- Only the case's `assignedLegalRepId` can raise a request, and only while the case is `In Progress` or already `Waiting on Input` (multiple concurrent open requests are allowed, WF-08) — no legal_manager/admin override here (unlike case core's escalation, which was deliberately widened).
- No attachment support (`information_request_attachments`) in this sub-project — deferred to the documents module (sub-project 3).
- No due-date automation — `dueDate` is stored only, never read by any job or notification in this sub-project.
- Every route returning a `Date`-typed field through a Zod `z.string()` schema must explicitly convert at the route boundary (`.toISOString()`) — `fastify-type-provider-zod` does not implicitly coerce `Date` to string, and a bare TypeORM row returned through a response schema that declares `z.string()` 500s (`FST_ERR_RESPONSE_SERIALIZATION`). Case core discovered this the hard way (see `decisions/case-core/task-07-assign-reassign.md`); this plan's own code already accounts for it — don't regress it.

## Review Focus

- Raising a **second** concurrent information request while the case is already `Waiting on Input` must succeed — new row created, case status unchanged (no-op, not an error) — per WF-08's "every open request" wording implying more than one can be open at once.
- Responding to a request when **other** open requests remain on the same case must **not** move the case back to `In Progress` — only when every open request on that case is answered.
- Reopening must force the case back to `Waiting on Input` **even when all other requests on the case are already answered** (case was back in `In Progress`) — this is an unconditional transition, not gated like the respond path.
- A responder holding a role other than `requester` (e.g. `legal_rep`, `admin`) must be able to call the respond endpoint and succeed — easy mistake is to gate that route with a role restriction that excludes non-requester responders.
- The requester-as-responder visibility extension must grant **read** access to the case (detail and listing) but must **not** grant any write access to case-core's mutation routes (assign/close/escalate/etc.) — visibility and authorization are separate concerns in case core's existing code, and this sub-project must not blur them.

---

### Task 1: InformationRequest entity, migration, and test fixtures

**Files:**
- Create: `src/db/migrations/1700000011000-create-information-requests.ts`
- Modify: `src/db/migrations/index.ts`
- Create: `src/modules/information-requests/entities/information-request.entity.ts`
- Modify: `src/db/entities.ts`
- Create: `test/integration/helpers/seed-information-request.ts`
- Test: `test/integration/modules/information-requests/information-request-entity.test.ts`

**Interfaces:**
- Produces: `InformationRequest` entity class (`id, caseId, subject, requirementDescription, raisedById, responderId, dueDate, status, responseText, reopenedFromId, createdAt, updatedAt`), `type InformationRequestStatus = 'open' | 'answered' | 'superseded'`; `seedInformationRequest(dataSource, overrides): Promise<InformationRequest>` — later tasks' tests build fixtures on top of this and case core's existing `seedCaseMasterData`/`seedCase`/`seedUserWithRole`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/information-requests/information-request-entity.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedInformationRequest } from '../../helpers/seed-information-request';

describe('InformationRequest entity + migration', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('round-trips an information request row through the repository', async () => {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');

    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const responderId = await seedUserWithRole(ds, 'requester');
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    expect(infoRequest.id).toBeTruthy();
    expect(infoRequest.status).toBe('open');
    expect(infoRequest.caseId).toBe(caseRow.id);
    expect(infoRequest.reopenedFromId).toBeNull();
    expect(infoRequest.responseText).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/information-requests/information-request-entity.test.ts`
Expected: FAIL — `Cannot find module '../../helpers/seed-information-request'`

- [ ] **Step 3: Write the migration**

```typescript
// src/db/migrations/1700000011000-create-information-requests.ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateInformationRequests1700000011000 implements MigrationInterface {
  name = 'CreateInformationRequests1700000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'information_requests',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid' },
          { name: 'subject', type: 'varchar' },
          { name: 'requirementDescription', type: 'varchar' },
          { name: 'raisedById', type: 'uuid' },
          { name: 'responderId', type: 'uuid' },
          { name: 'dueDate', type: 'timestamptz', isNullable: true },
          { name: 'status', type: 'varchar', default: `'open'` },
          { name: 'responseText', type: 'varchar', isNullable: true },
          { name: 'reopenedFromId', type: 'uuid', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['caseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['raisedById'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['responderId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['reopenedFromId'], referencedTableName: 'information_requests', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('information_requests');
  }
}
```

- [ ] **Step 4: Register the migration**

```typescript
// src/db/migrations/index.ts — add import and array entry
import { CreateInformationRequests1700000011000 } from './1700000011000-create-information-requests';

export const migrations = [
  CreateUsersAndRoles1700000001000,
  CreateAuditLog1700000002000,
  CreateSimpleMasterData1700000003000,
  CreateEntitiesAndBusinessUnits1700000004000,
  CreateCaseTypes1700000005000,
  CreateRoutingRules1700000006000,
  AddUserOrgFks1700000007000,
  AddMasterDataCompositeUniques1700000008000,
  AddRefreshTokenHashIndex1700000009000,
  CreateCases1700000010000,
  CreateInformationRequests1700000011000,
];
```

- [ ] **Step 5: Write the entity**

```typescript
// src/modules/information-requests/entities/information-request.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type InformationRequestStatus = 'open' | 'answered' | 'superseded';

@Entity('information_requests')
export class InformationRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  caseId!: string;

  @Column({ type: 'varchar' })
  subject!: string;

  @Column({ type: 'varchar' })
  requirementDescription!: string;

  @Column({ type: 'uuid' })
  raisedById!: string;

  @Column({ type: 'uuid' })
  responderId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  dueDate!: Date | null;

  @Column({ type: 'varchar', default: 'open' })
  status!: InformationRequestStatus;

  @Column({ type: 'varchar', nullable: true })
  responseText!: string | null;

  @Column({ type: 'uuid', nullable: true })
  reopenedFromId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
```

- [ ] **Step 6: Register the entity**

```typescript
// src/db/entities.ts — add import and array entry
import { InformationRequest } from '../modules/information-requests/entities/information-request.entity';

export const entities = [
  Role, User, UserRole, RefreshToken, AuditLog,
  Department, CaseCategory, ClosureOutcome, OrgEntity, BusinessUnit, CaseType, RoutingRule,
  Case,
  InformationRequest,
];
```

- [ ] **Step 7: Write the test fixture**

```typescript
// test/integration/helpers/seed-information-request.ts
import type { DataSource } from 'typeorm';
import { InformationRequest } from '../../../src/modules/information-requests/entities/information-request.entity';

export async function seedInformationRequest(
  dataSource: DataSource,
  overrides: Partial<{
    caseId: string;
    subject: string;
    requirementDescription: string;
    raisedById: string;
    responderId: string;
    dueDate: Date | null;
    status: InformationRequest['status'];
    responseText: string | null;
    reopenedFromId: string | null;
  }> = {},
): Promise<InformationRequest> {
  function mustProvide(field: string): never {
    throw new Error(`seedInformationRequest: ${field} is required`);
  }
  const repo = dataSource.getRepository(InformationRequest);
  const row = repo.create({
    caseId: overrides.caseId ?? mustProvide('caseId'),
    subject: overrides.subject ?? 'Need clarification on scope',
    requirementDescription: overrides.requirementDescription ?? 'Please confirm the affected business unit.',
    raisedById: overrides.raisedById ?? mustProvide('raisedById'),
    responderId: overrides.responderId ?? mustProvide('responderId'),
    dueDate: overrides.dueDate ?? null,
    status: overrides.status ?? 'open',
    responseText: overrides.responseText ?? null,
    reopenedFromId: overrides.reopenedFromId ?? null,
  });
  return repo.save(row);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/information-requests/information-request-entity.test.ts`
Expected: PASS (1 test)

- [ ] **Step 9: Commit**

Write a decision-log entry first: create `decisions/information-requests/task-01-entity-migration-fixtures.md` (follow the format of `decisions/case-core/task-01-fix-org-structure-test.md` — a `# Task N — <title>` heading, `**Date:**` line, **What:**/**Why:** paragraphs), then add a new `## information-requests (Phase 2, sub-project 2)` section to the top of root `decisions.md` (above the existing `## case-core` section) with one bullet linking to this file. Stage the code, test, and both decision files together and commit in one commit (standing convention — one commit per task, code and decisions together):

```bash
git add src/db/migrations/1700000011000-create-information-requests.ts src/db/migrations/index.ts src/modules/information-requests/entities/information-request.entity.ts src/db/entities.ts test/integration/helpers/seed-information-request.ts test/integration/modules/information-requests/information-request-entity.test.ts decisions.md decisions/information-requests/task-01-entity-migration-fixtures.md
git commit -m "feat: information_requests table, entity, and test fixtures"
```

---

### Task 2: Information-request schemas

**Files:**
- Create: `src/modules/information-requests/information-requests.schemas.ts`
- Test: `test/unit/modules/information-requests/information-requests.schemas.test.ts`

**Interfaces:**
- Produces: `INFO_REQUEST_STATUSES` (const array), `raiseInformationRequestBodySchema`, `respondInformationRequestBodySchema`, `reopenInformationRequestBodySchema`, `informationRequestIdParamsSchema`, `informationRequestResponseSchema`, `informationRequestListResponseSchema` — consumed by `information-requests.routes.ts` (Tasks 4–7).

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/modules/information-requests/information-requests.schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  raiseInformationRequestBodySchema,
  respondInformationRequestBodySchema,
  reopenInformationRequestBodySchema,
} from '../../../../src/modules/information-requests/information-requests.schemas';

describe('information-request schemas', () => {
  it('accepts a valid raise body without a dueDate', () => {
    const result = raiseInformationRequestBodySchema.safeParse({
      subject: 'Need clarification',
      requirementDescription: 'Please confirm the affected business unit.',
      responderId: '11111111-4111-8111-1111-111111111111',
    });
    expect(result.success).toBe(true);
  });

  it('coerces a valid ISO dueDate string to a Date', () => {
    const result = raiseInformationRequestBodySchema.parse({
      subject: 'Need clarification',
      requirementDescription: 'Please confirm the affected business unit.',
      responderId: '11111111-4111-8111-1111-111111111111',
      dueDate: '2026-12-01T00:00:00.000Z',
    });
    expect(result.dueDate).toBeInstanceOf(Date);
  });

  it('rejects a raise body missing requirementDescription', () => {
    const result = raiseInformationRequestBodySchema.safeParse({
      subject: 'Need clarification',
      responderId: '11111111-4111-8111-1111-111111111111',
    });
    expect(result.success).toBe(false);
  });

  it('requires non-empty responseText', () => {
    expect(respondInformationRequestBodySchema.safeParse({ responseText: '' }).success).toBe(false);
    expect(respondInformationRequestBodySchema.safeParse({ responseText: 'Here is the clarification.' }).success).toBe(true);
  });

  it('requires a non-empty comment to reopen (VC-11)', () => {
    expect(reopenInformationRequestBodySchema.safeParse({ comment: '' }).success).toBe(false);
    expect(reopenInformationRequestBodySchema.safeParse({ comment: 'This does not answer the question.' }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/modules/information-requests/information-requests.schemas.test.ts`
Expected: FAIL — `Cannot find module '../../../../src/modules/information-requests/information-requests.schemas'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/modules/information-requests/information-requests.schemas.ts
import { z } from 'zod';

export const INFO_REQUEST_STATUSES = ['open', 'answered', 'superseded'] as const;

export const raiseInformationRequestBodySchema = z.object({
  subject: z.string().min(1),
  requirementDescription: z.string().min(1),
  responderId: z.string().uuid(),
  dueDate: z.coerce.date().optional(),
});

export const respondInformationRequestBodySchema = z.object({
  responseText: z.string().min(1),
});

export const reopenInformationRequestBodySchema = z.object({
  comment: z.string().min(1),
});

export const informationRequestIdParamsSchema = z.object({ id: z.string().uuid() });

export const informationRequestResponseSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  subject: z.string(),
  requirementDescription: z.string(),
  raisedById: z.string(),
  responderId: z.string(),
  dueDate: z.string().nullable(),
  status: z.enum(INFO_REQUEST_STATUSES),
  responseText: z.string().nullable(),
  reopenedFromId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const informationRequestListResponseSchema = z.array(informationRequestResponseSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/modules/information-requests/information-requests.schemas.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

Create `decisions/information-requests/task-02-schemas.md` (same format as Task 1's), add one bullet to the top of the `## information-requests` section in `decisions.md` (above the Task 1 line).

```bash
git add src/modules/information-requests/information-requests.schemas.ts test/unit/modules/information-requests/information-requests.schemas.test.ts decisions.md decisions/information-requests/task-02-schemas.md
git commit -m "feat: information-request Zod schemas"
```

---

### Task 3: Case-transition helpers (markCaseWaitingOnInput / markCaseInProgress)

**Files:**
- Modify: `src/modules/cases/cases.workflow.service.ts`
- Test: `test/integration/modules/cases/information-request-transitions.test.ts`

**Interfaces:**
- Consumes: `assertTransition` (already imported in this file), `logAuditEvent`.
- Produces: `markCaseWaitingOnInput(dataSource, actorId, caseId): Promise<Case>` — no-ops (no mutation, no audit) if the case is already `Waiting on Input`; otherwise validates and applies the transition. `markCaseInProgress(dataSource, actorId, caseId): Promise<Case>` — validates and applies the `Waiting on Input → In Progress` transition (no no-op case; this is only ever called when the caller has confirmed every open request is answered). Both consumed by `information-requests.service.ts` (Tasks 4–6) — **this task has no route of its own**; it's tested by calling the functions directly against fixtures, the same way case core's early pure-logic tasks were tested before any route existed.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/cases/information-request-transitions.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { markCaseWaitingOnInput, markCaseInProgress } from '../../../../src/modules/cases/cases.workflow.service';

describe('markCaseWaitingOnInput / markCaseInProgress', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  async function reset() {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('moves an In Progress case to Waiting on Input and logs an audit entry', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const updated = await markCaseWaitingOnInput(ds, repId, caseRow.id);

    expect(updated.status).toBe('Waiting on Input');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.waiting_on_input'`);
    expect(auditRows).toHaveLength(1);
  });

  it('no-ops (no mutation, no audit) when the case is already Waiting on Input', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const updated = await markCaseWaitingOnInput(ds, repId, caseRow.id);

    expect(updated.status).toBe('Waiting on Input');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.waiting_on_input'`);
    expect(auditRows).toHaveLength(0);
  });

  it('moves a Waiting on Input case back to In Progress and logs an audit entry', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const updated = await markCaseInProgress(ds, repId, caseRow.id);

    expect(updated.status).toBe('In Progress');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.resumed_in_progress'`);
    expect(auditRows).toHaveLength(1);
  });

  it('rejects moving a Submitted case to Waiting on Input (invalid transition)', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });

    await expect(markCaseWaitingOnInput(ds, requesterId, caseRow.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/cases/information-request-transitions.test.ts`
Expected: FAIL — `markCaseWaitingOnInput is not a function` (or similar — the export doesn't exist yet)

- [ ] **Step 3: Add the two functions**

```typescript
// src/modules/cases/cases.workflow.service.ts — add at the end of the file
export async function markCaseWaitingOnInput(dataSource: DataSource, actorId: string, caseId: string): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  if (caseRow.status === 'Waiting on Input') {
    return caseRow;
  }
  assertTransition(caseRow.status as CaseStatus, 'Waiting on Input');

  const before = { id: caseRow.id, status: caseRow.status };
  caseRow.status = 'Waiting on Input';
  await dataSource.getRepository(Case).save(caseRow);
  await logAuditEvent(dataSource, {
    actorId,
    caseId: caseRow.id,
    action: 'case.waiting_on_input',
    beforeValue: before,
    afterValue: { id: caseRow.id, status: caseRow.status, referenceNumber: caseRow.referenceNumber },
  });
  return caseRow;
}

export async function markCaseInProgress(dataSource: DataSource, actorId: string, caseId: string): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  assertTransition(caseRow.status as CaseStatus, 'In Progress');

  const before = { id: caseRow.id, status: caseRow.status };
  caseRow.status = 'In Progress';
  await dataSource.getRepository(Case).save(caseRow);
  await logAuditEvent(dataSource, {
    actorId,
    caseId: caseRow.id,
    action: 'case.resumed_in_progress',
    beforeValue: before,
    afterValue: { id: caseRow.id, status: caseRow.status, referenceNumber: caseRow.referenceNumber },
  });
  return caseRow;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/cases/information-request-transitions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

Create `decisions/information-requests/task-03-case-transition-helpers.md`, add one bullet to the top of the `## information-requests` section in `decisions.md`.

```bash
git add src/modules/cases/cases.workflow.service.ts test/integration/modules/cases/information-request-transitions.test.ts decisions.md decisions/information-requests/task-03-case-transition-helpers.md
git commit -m "feat: case-transition helpers for the information-request workflow"
```

---

### Task 4: Raise an information request

**Files:**
- Create: `src/modules/information-requests/information-requests.service.ts`
- Create: `src/modules/information-requests/information-requests.routes.ts`
- Modify: `src/app.ts`
- Test: `test/integration/modules/information-requests/raise.test.ts`

**Interfaces:**
- Consumes: `markCaseWaitingOnInput` (Task 3), `raiseInformationRequestBodySchema`/`informationRequestResponseSchema`/`informationRequestIdParamsSchema` (Task 2), `Actor` type from `../cases/cases.service`, `seedInformationRequest`/`seedCaseMasterData`/`seedCase`/`seedUserWithRole`.
- Produces: `type RaiseInformationRequestInput = {subject, requirementDescription, responderId, dueDate?}`, `raiseInformationRequest(dataSource, actorId, caseId, input): Promise<InformationRequest>` — consumed by Task 5/6's tests for fixture setup via the route; `serializeInformationRequest(row): object` exported from `information-requests.routes.ts`, the Date→string boundary conversion (same pattern as case core's `serializeCase`) — consumed by every later task's route in this file. Route `POST /cases/:id/information-requests`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/information-requests/raise.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';

describe('POST /cases/:id/information-requests', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  async function reset() {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('lets the assigned, accepted legal_rep raise a request, moving the case to Waiting on Input', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'Need clarification', requirementDescription: 'Please confirm the affected business unit.', responderId },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('open');
    expect(res.json().responderId).toBe(responderId);

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'info_request.raised'`);
    expect(auditRows).toHaveLength(1);
    await app.close();
  });

  it('allows raising a second concurrent request while the case is already Waiting on Input (WF-08)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'Second question', requirementDescription: 'A second, independent question.', responderId },
    });

    expect(res.statusCode).toBe(201);
    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('rejects a legal_rep raising a request on a case not assigned to them', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const token = app.signAccessToken({ id: otherRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'x', requirementDescription: 'x', responderId },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects raising a request on a Submitted case (not yet accepted)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: 'x', requirementDescription: 'x', responderId },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/information-requests/raise.test.ts`
Expected: FAIL — `/cases/:id/information-requests` route doesn't exist (404)

- [ ] **Step 3: Write `information-requests.service.ts`**

```typescript
// src/modules/information-requests/information-requests.service.ts
import type { DataSource } from 'typeorm';
import { InformationRequest } from './entities/information-request.entity';
import { Case } from '../cases/entities/case.entity';
import { User } from '../users/entities/user.entity';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';
import { markCaseWaitingOnInput, markCaseInProgress } from '../cases/cases.workflow.service';

export type RaiseInformationRequestInput = {
  subject: string;
  requirementDescription: string;
  responderId: string;
  dueDate?: Date;
};

async function loadCaseOrThrow(dataSource: DataSource, caseId: string): Promise<Case> {
  const caseRow = await dataSource.getRepository(Case).findOne({ where: { id: caseId } });
  if (!caseRow) {
    throw new NotFoundError('Case not found');
  }
  return caseRow;
}

export async function raiseInformationRequest(
  dataSource: DataSource,
  actorId: string,
  caseId: string,
  input: RaiseInformationRequestInput,
): Promise<InformationRequest> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  if (caseRow.assignedLegalRepId !== actorId) {
    throw new ForbiddenError('Only the assigned legal representative can raise an information request on this case');
  }
  if (caseRow.status !== 'In Progress' && caseRow.status !== 'Waiting on Input') {
    throw new ConflictError('Information requests can only be raised on an In Progress or Waiting on Input case');
  }

  const responder = await dataSource.getRepository(User).findOne({ where: { id: input.responderId } });
  if (!responder || !responder.isActive) {
    throw new ValidationError('Unknown or inactive responderId');
  }

  const repo = dataSource.getRepository(InformationRequest);
  const infoRequest = await repo.save(
    repo.create({
      caseId,
      subject: input.subject,
      requirementDescription: input.requirementDescription,
      raisedById: actorId,
      responderId: input.responderId,
      dueDate: input.dueDate ?? null,
      status: 'open',
      responseText: null,
      reopenedFromId: null,
    }),
  );

  await markCaseWaitingOnInput(dataSource, actorId, caseId);

  await logAuditEvent(dataSource, {
    actorId,
    caseId,
    action: 'info_request.raised',
    afterValue: { id: infoRequest.id, caseId, referenceNumber: caseRow.referenceNumber, responderId: infoRequest.responderId },
  });

  return infoRequest;
}
```

- [ ] **Step 4: Write `information-requests.routes.ts`**

```typescript
// src/modules/information-requests/information-requests.routes.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import type { InformationRequest } from './entities/information-request.entity';
import { raiseInformationRequest } from './information-requests.service';
import {
  raiseInformationRequestBodySchema,
  informationRequestResponseSchema,
} from './information-requests.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';

// Same Date -> ISO-string boundary conversion case core's serializeCase does,
// for the same reason: fastify-type-provider-zod validates-then-serializes
// against informationRequestResponseSchema's z.string() timestamp fields, and
// does not implicitly coerce a Date. Exported so every other route in this
// file reuses it instead of re-deriving the conversion.
export function serializeInformationRequest(row: InformationRequest) {
  return {
    ...row,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function informationRequestsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/cases/:id/information-requests', {
    preHandler: [app.authenticate, requireRole(['legal_rep'])],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: raiseInformationRequestBodySchema,
      response: { 201: informationRequestResponseSchema },
    },
  }, async (request, reply) => {
    const infoRequest = await raiseInformationRequest(app.dataSource, request.user.id, request.params.id, request.body);
    reply.status(201).send(serializeInformationRequest(infoRequest));
  });
}
```

- [ ] **Step 5: Register the routes module**

```typescript
// src/app.ts — add import
import informationRequestsRoutes from './modules/information-requests/information-requests.routes';

// inside buildApp(dataSource), after app.register(casesRoutes):
app.register(informationRequestsRoutes);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/information-requests/raise.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

Create `decisions/information-requests/task-04-raise.md`, add one bullet to the top of the `## information-requests` section in `decisions.md`.

```bash
git add src/modules/information-requests/information-requests.service.ts src/modules/information-requests/information-requests.routes.ts src/app.ts test/integration/modules/information-requests/raise.test.ts decisions.md decisions/information-requests/task-04-raise.md
git commit -m "feat: POST /cases/:id/information-requests — raise"
```

---

### Task 5: Respond to an information request

**Files:**
- Modify: `src/modules/information-requests/information-requests.service.ts`
- Modify: `src/modules/information-requests/information-requests.routes.ts`
- Test: `test/integration/modules/information-requests/respond.test.ts`

**Interfaces:**
- Consumes: `markCaseInProgress` (Task 3), `serializeInformationRequest` (Task 4, already in scope in the same routes file).
- Produces: `respondToInformationRequest(dataSource, actorId, requestId, responseText): Promise<InformationRequest>`. Route `POST /information-requests/:id/respond`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/information-requests/respond.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';

describe('POST /information-requests/:id/respond', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  async function reset() {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('lets the responder answer, returning the case to In Progress when it was the only open request', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'The affected business unit is Operations.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('answered');
    expect(res.json().responseText).toBe('The affected business unit is Operations.');

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('In Progress');
    await app.close();
  });

  it('leaves the case Waiting on Input when another open request remains', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const firstRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'Second question' });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${firstRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'Answering the first one.' },
    });

    expect(res.statusCode).toBe(200);
    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('rejects a response from anyone other than the assigned responder', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const someoneElseId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const token = app.signAccessToken({ id: someoneElseId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'x' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects responding to an already-answered request', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'already answered' });
    const token = app.signAccessToken({ id: responderId, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'trying again' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('lets a responder holding the legal_rep role respond (PR-11: responder can be any role)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderRepId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: responderRepId });
    const token = app.signAccessToken({ id: responderRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${infoRequest.id}/respond`,
      headers: { authorization: `Bearer ${token}` },
      payload: { responseText: 'Responding as a legal_rep, not a requester.' },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/information-requests/respond.test.ts`
Expected: FAIL — `/information-requests/:id/respond` route doesn't exist (404)

- [ ] **Step 3: Add `respondToInformationRequest` to `information-requests.service.ts`**

```typescript
// src/modules/information-requests/information-requests.service.ts — add at the end of the file
async function loadInformationRequestOrThrow(dataSource: DataSource, requestId: string): Promise<InformationRequest> {
  const row = await dataSource.getRepository(InformationRequest).findOne({ where: { id: requestId } });
  if (!row) {
    throw new NotFoundError('Information request not found');
  }
  return row;
}

export async function respondToInformationRequest(
  dataSource: DataSource,
  actorId: string,
  requestId: string,
  responseText: string,
): Promise<InformationRequest> {
  const infoRequest = await loadInformationRequestOrThrow(dataSource, requestId);
  if (infoRequest.responderId !== actorId) {
    throw new ForbiddenError('Only the assigned responder can answer this information request');
  }
  if (infoRequest.status !== 'open') {
    throw new ConflictError('This information request is not open');
  }

  const repo = dataSource.getRepository(InformationRequest);
  infoRequest.status = 'answered';
  infoRequest.responseText = responseText;
  await repo.save(infoRequest);

  const otherOpenCount = await repo.count({ where: { caseId: infoRequest.caseId, status: 'open' } });
  if (otherOpenCount === 0) {
    await markCaseInProgress(dataSource, actorId, infoRequest.caseId);
  }

  await logAuditEvent(dataSource, {
    actorId,
    caseId: infoRequest.caseId,
    action: 'info_request.answered',
    afterValue: { id: infoRequest.id, caseId: infoRequest.caseId },
  });

  return infoRequest;
}
```

- [ ] **Step 4: Add the route**

```typescript
// src/modules/information-requests/information-requests.routes.ts — add these imports
import { raiseInformationRequest, respondToInformationRequest } from './information-requests.service';
import {
  raiseInformationRequestBodySchema,
  respondInformationRequestBodySchema,
  informationRequestIdParamsSchema,
  informationRequestResponseSchema,
} from './information-requests.schemas';

// add inside informationRequestsRoutes(), after the raise route:
  typedApp.post('/information-requests/:id/respond', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: informationRequestIdParamsSchema,
      body: respondInformationRequestBodySchema,
      response: { 200: informationRequestResponseSchema },
    },
  }, async (request) => {
    const infoRequest = await respondToInformationRequest(app.dataSource, request.user.id, request.params.id, request.body.responseText);
    return serializeInformationRequest(infoRequest);
  });
```

Note: no `requireRole` on this route — per PR-11/the Global Constraints, a responder can hold any role, so the route only requires authentication; the service-layer `responderId` check is the actual restriction.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/information-requests/respond.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

Create `decisions/information-requests/task-05-respond.md`, add one bullet to the top of the `## information-requests` section in `decisions.md`.

```bash
git add src/modules/information-requests/information-requests.service.ts src/modules/information-requests/information-requests.routes.ts test/integration/modules/information-requests/respond.test.ts decisions.md decisions/information-requests/task-05-respond.md
git commit -m "feat: POST /information-requests/:id/respond"
```

---

### Task 6: Reopen an information request

**Files:**
- Modify: `src/modules/information-requests/information-requests.service.ts`
- Modify: `src/modules/information-requests/information-requests.routes.ts`
- Test: `test/integration/modules/information-requests/reopen.test.ts`

**Interfaces:**
- Consumes: `markCaseWaitingOnInput` (Task 3).
- Produces: `reopenInformationRequest(dataSource, actorId, requestId, comment): Promise<InformationRequest>` — the new row returned is the newly-created one, not the superseded one. Route `POST /information-requests/:id/reopen`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/information-requests/reopen.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';

describe('POST /information-requests/:id/reopen', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  async function reset() {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('lets the raiser reopen an answered request, creating a new row and superseding the old one', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'Insufficient answer' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'This does not specify which business unit — please clarify.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('open');
    expect(res.json().reopenedFromId).toBe(answered.id);
    expect(res.json().requirementDescription).toBe('This does not specify which business unit — please clarify.');
    expect(res.json().id).not.toBe(answered.id);

    const [supersededRow] = await ds.query(`SELECT status FROM information_requests WHERE id = $1`, [answered.id]);
    expect(supersededRow.status).toBe('superseded');

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('forces Waiting on Input even when the case is already back In Progress with no other open requests', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'reopening' },
    });

    const [caseAfter] = await ds.query(`SELECT status FROM cases WHERE id = $1`, [caseRow.id]);
    expect(caseAfter.status).toBe('Waiting on Input');
    await app.close();
  });

  it('rejects reopening by someone other than the original raiser', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const token = app.signAccessToken({ id: otherRepId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'x' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects reopening a request that is still open', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    const openRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'open' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${openRequest.id}/reopen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { comment: 'x' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/information-requests/reopen.test.ts`
Expected: FAIL — `/information-requests/:id/reopen` route doesn't exist (404)

- [ ] **Step 3: Add `reopenInformationRequest` to `information-requests.service.ts`**

```typescript
// src/modules/information-requests/information-requests.service.ts — add at the end of the file
export async function reopenInformationRequest(
  dataSource: DataSource,
  actorId: string,
  requestId: string,
  comment: string,
): Promise<InformationRequest> {
  const superseded = await loadInformationRequestOrThrow(dataSource, requestId);
  if (superseded.raisedById !== actorId) {
    throw new ForbiddenError('Only the legal representative who raised this request can reopen it');
  }
  if (superseded.status !== 'answered') {
    throw new ConflictError('Only an answered information request can be reopened');
  }

  const repo = dataSource.getRepository(InformationRequest);
  superseded.status = 'superseded';
  await repo.save(superseded);

  const reopened = await repo.save(
    repo.create({
      caseId: superseded.caseId,
      subject: superseded.subject,
      requirementDescription: comment,
      raisedById: superseded.raisedById,
      responderId: superseded.responderId,
      dueDate: null,
      status: 'open',
      responseText: null,
      reopenedFromId: superseded.id,
    }),
  );

  await markCaseWaitingOnInput(dataSource, actorId, superseded.caseId);

  await logAuditEvent(dataSource, {
    actorId,
    caseId: superseded.caseId,
    action: 'info_request.reopened',
    beforeValue: { id: superseded.id, status: 'answered' },
    afterValue: { id: reopened.id, caseId: superseded.caseId, reopenedFromId: superseded.id },
  });

  return reopened;
}
```

- [ ] **Step 4: Add the route**

```typescript
// src/modules/information-requests/information-requests.routes.ts — add these imports
import { raiseInformationRequest, respondToInformationRequest, reopenInformationRequest } from './information-requests.service';
import {
  raiseInformationRequestBodySchema,
  respondInformationRequestBodySchema,
  reopenInformationRequestBodySchema,
  informationRequestIdParamsSchema,
  informationRequestResponseSchema,
} from './information-requests.schemas';

// add inside informationRequestsRoutes(), after the respond route:
  typedApp.post('/information-requests/:id/reopen', {
    preHandler: [app.authenticate, requireRole(['legal_rep'])],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: informationRequestIdParamsSchema,
      body: reopenInformationRequestBodySchema,
      response: { 200: informationRequestResponseSchema },
    },
  }, async (request) => {
    const infoRequest = await reopenInformationRequest(app.dataSource, request.user.id, request.params.id, request.body.comment);
    return serializeInformationRequest(infoRequest);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/information-requests/reopen.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

Create `decisions/information-requests/task-06-reopen.md`, add one bullet to the top of the `## information-requests` section in `decisions.md`.

```bash
git add src/modules/information-requests/information-requests.service.ts src/modules/information-requests/information-requests.routes.ts test/integration/modules/information-requests/reopen.test.ts decisions.md decisions/information-requests/task-06-reopen.md
git commit -m "feat: POST /information-requests/:id/reopen"
```

---

### Task 7: List information requests for a case

**Files:**
- Modify: `src/modules/information-requests/information-requests.service.ts`
- Modify: `src/modules/information-requests/information-requests.routes.ts`
- Test: `test/integration/modules/information-requests/list.test.ts`

**Interfaces:**
- Consumes: `getCaseById` from `../cases/cases.service` (reused as the visibility gate — see rationale in Step 3), `Actor` type from the same module.
- Produces: `listInformationRequestsForCase(dataSource, actor, caseId): Promise<InformationRequest[]>`, ordered newest-first. Route `GET /cases/:id/information-requests`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/information-requests/list.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';

describe('GET /cases/:id/information-requests', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  async function reset() {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('lists all requests for a case the caller can see, newest first', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    const first = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'Second' });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/information-requests`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0].id).toBe(second.id);
    expect(res.json()[1].id).toBe(first.id);
    await app.close();
  });

  it('returns 404 for a case the caller cannot see (reuses case-core visibility)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const masterA = await seedCaseMasterData(ds);
    const masterB = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    const requesterB = await seedUserWithRole(ds, 'requester', { departmentId: masterB.departmentId, entityId: masterB.entityId });
    const caseRow = await seedCase(ds, { ...masterB, requesterId: requesterB, status: 'In Progress', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: masterA.departmentId, entityId: masterA.entityId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: masterA.departmentId, entityId: masterA.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/information-requests`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/information-requests/list.test.ts`
Expected: FAIL — `/cases/:id/information-requests` GET route doesn't exist (404, but for the wrong reason — the whole route is missing, not a visibility 404)

- [ ] **Step 3: Add `listInformationRequestsForCase` to `information-requests.service.ts`**

```typescript
// src/modules/information-requests/information-requests.service.ts — add this import
import { getCaseById, type Actor } from '../cases/cases.service';

// add at the end of the file
// Reuses case core's getCaseById purely as a visibility gate: it throws
// NotFoundError (404) under the exact same rule case detail/list already
// enforce (role-scoped, with the requester's department check extended in
// Task 8 to also cover a requester who's a responder on this case). This
// keeps one single source of truth for "can this actor see this case" rather
// than re-deriving the rule here.
export async function listInformationRequestsForCase(dataSource: DataSource, actor: Actor, caseId: string): Promise<InformationRequest[]> {
  await getCaseById(dataSource, actor, caseId);
  return dataSource.getRepository(InformationRequest).find({ where: { caseId }, order: { createdAt: 'DESC' } });
}
```

- [ ] **Step 4: Add the route**

```typescript
// src/modules/information-requests/information-requests.routes.ts — add these imports
import { raiseInformationRequest, respondToInformationRequest, reopenInformationRequest, listInformationRequestsForCase } from './information-requests.service';
import {
  raiseInformationRequestBodySchema,
  respondInformationRequestBodySchema,
  reopenInformationRequestBodySchema,
  informationRequestIdParamsSchema,
  informationRequestResponseSchema,
  informationRequestListResponseSchema,
} from './information-requests.schemas';

// add inside informationRequestsRoutes(), before the POST raise route:
  typedApp.get('/cases/:id/information-requests', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      response: { 200: informationRequestListResponseSchema },
    },
  }, async (request) => {
    const rows = await listInformationRequestsForCase(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }, request.params.id);
    return rows.map(serializeInformationRequest);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/information-requests/list.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

Create `decisions/information-requests/task-07-list.md`, add one bullet to the top of the `## information-requests` section in `decisions.md`.

```bash
git add src/modules/information-requests/information-requests.service.ts src/modules/information-requests/information-requests.routes.ts test/integration/modules/information-requests/list.test.ts decisions.md decisions/information-requests/task-07-list.md
git commit -m "feat: GET /cases/:id/information-requests"
```

---

### Task 8: Requester-as-responder visibility extension (case core)

**Files:**
- Modify: `src/modules/cases/cases.service.ts`
- Test: `test/integration/modules/cases/responder-visibility.test.ts`

**Interfaces:**
- Produces: no new exports — extends the existing behavior of `listCases`/`getCaseById` (both already exported from this file, signatures unchanged).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/cases/responder-visibility.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';

describe('requester visibility extension — sees a case they are a responder on (AC-04)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  async function reset() {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }

  it('GET /cases/:id: a requester outside the case\'s department can see it once they are the responder on an information request', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const caseDepartment = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: caseDepartment.departmentId, entityId: caseDepartment.entityId });
    const outsiderDepartment = await seedCaseMasterData(ds);
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId });
    const caseRow = await seedCase(ds, { ...caseDepartment, requesterId: caseRequesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: outsiderRequesterId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}`, headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('GET /cases: the same case appears in that requester\'s list', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const caseDepartment = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: caseDepartment.departmentId, entityId: caseDepartment.entityId });
    const outsiderDepartment = await seedCaseMasterData(ds);
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId });
    const caseRow = await seedCase(ds, { ...caseDepartment, requesterId: caseRequesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: outsiderRequesterId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/cases', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((c: { id: string }) => c.id);
    expect(ids).toContain(caseRow.id);
    await app.close();
  });

  it('a requester who is a responder still cannot assign/close/escalate the case (visibility is not write access)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const caseDepartment = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: caseDepartment.departmentId, entityId: caseDepartment.entityId });
    const outsiderDepartment = await seedCaseMasterData(ds);
    const outsiderRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId });
    const caseRow = await seedCase(ds, { ...caseDepartment, requesterId: caseRequesterId, status: 'Waiting on Input', assignedLegalRepId: repId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: outsiderRequesterId });
    const token = app.signAccessToken({ id: outsiderRequesterId, role: 'requester', departmentId: outsiderDepartment.departmentId, entityId: outsiderDepartment.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/escalate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isEscalated: true, reason: 'x' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/cases/responder-visibility.test.ts`
Expected: FAIL — the first two tests get 404/empty-list instead of 200/containing the case

- [ ] **Step 3: Extend `getCaseById` and `listCases`**

```typescript
// src/modules/cases/cases.service.ts — replace the body of getCaseById
export async function getCaseById(dataSource: DataSource, actor: Actor, caseId: string) {
  const caseRow = await dataSource.getRepository(Case).findOne({ where: { id: caseId } });
  if (!caseRow) {
    throw new NotFoundError('Case not found');
  }
  if (actor.role === 'requester' && caseRow.departmentId !== actor.departmentId) {
    // AC-04: a requester also sees a case outside their department if an
    // information request has ever been assigned to them as responder on it.
    // Referenced by raw table name, not a TypeORM entity import, so this
    // module doesn't take a TypeScript dependency on information-requests —
    // only the reverse dependency (information-requests imports case core)
    // exists, keeping the module graph one-directional.
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM information_requests WHERE "caseId" = $1 AND "responderId" = $2`,
      [caseId, actor.id],
    );
    if (count === 0) {
      throw new NotFoundError('Case not found');
    }
  }
  return toCaseWithSla(caseRow);
}
```

```typescript
// src/modules/cases/cases.service.ts — replace the requester-scoping block in listCases
  if (actor.role === 'requester') {
    qb.andWhere(
      '(c."departmentId" = :actorDepartmentId OR EXISTS (SELECT 1 FROM information_requests ir WHERE ir."caseId" = c.id AND ir."responderId" = :actorId))',
      { actorDepartmentId: actor.departmentId, actorId: actor.id },
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/cases/responder-visibility.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the existing case-core visibility tests to confirm no regression**

Run: `npx vitest run test/integration/modules/cases/list-and-get.test.ts`
Expected: PASS (6 tests, unchanged)

- [ ] **Step 6: Commit**

Create `decisions/information-requests/task-08-responder-visibility.md`, add one bullet to the top of the `## information-requests` section in `decisions.md`.

```bash
git add src/modules/cases/cases.service.ts test/integration/modules/cases/responder-visibility.test.ts decisions.md decisions/information-requests/task-08-responder-visibility.md
git commit -m "feat: requester sees a case they're a responder on (AC-04)"
```

---

### Task 9: Closure guard — no open information requests (VC-12)

**Files:**
- Modify: `src/modules/cases/cases.workflow.service.ts`
- Test: `test/integration/modules/cases/close.test.ts`

**Interfaces:**
- Produces: no new exports — extends `closeCase`'s existing behavior (signature unchanged).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/cases/close.test.ts — add this test to the existing describe block
  it('rejects closing a case with an open information request (VC-12)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'open' });
    const outcomeId = await seedOutcome();
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: true, closureSummary: 'x', closureOutcomeId: outcomeId },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });
```

This test file's `reset()` helper also needs `await ds.query('DELETE FROM information_requests');` added (before the `cases` delete, since `information_requests.caseId` has a `RESTRICT` foreign key to `cases`), and the file needs one new import:

```typescript
// test/integration/modules/cases/close.test.ts — add this import at the top
import { seedInformationRequest } from '../../helpers/seed-information-request';

// and update reset() to:
  async function reset() {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM closure_outcomes');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/modules/cases/close.test.ts`
Expected: FAIL — closure succeeds (200) instead of being rejected (409); the new open information request has no effect yet

- [ ] **Step 3: Add the guard to `closeCase`**

```typescript
// src/modules/cases/cases.workflow.service.ts — add this check inside closeCase,
// right after the closureOutcome validation and before the `before = {...}` line:
  // VC-12/WF-10: closure is blocked while any information request on this
  // case remains open. Raw SQL, not a TypeORM entity import, for the same
  // reason as cases.service.ts's responder-visibility extension — keeps
  // this module from taking a TypeScript dependency on information-requests.
  const [{ count: openRequestCount }] = await dataSource.query(
    `SELECT COUNT(*)::int AS count FROM information_requests WHERE "caseId" = $1 AND status = 'open'`,
    [caseRow.id],
  );
  if (openRequestCount > 0) {
    throw new ConflictError('Case cannot be closed while an information request is still open (VC-12)');
  }
```

This needs `ConflictError` imported — it already is (`cases.workflow.service.ts` already imports `ConflictError`? — check the current top-of-file imports; if not already present, add it to the existing `import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors';` line to become `import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../shared/errors';`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/modules/cases/close.test.ts`
Expected: PASS (5 tests — the 4 pre-existing plus this new one)

- [ ] **Step 5: Run the full information-requests + case-core suites together**

Run: `npx vitest run test/unit/modules/information-requests test/integration/modules/information-requests test/unit/modules/cases test/integration/modules/cases`
Expected: all PASS

- [ ] **Step 6: Commit**

Create `decisions/information-requests/task-09-closure-guard.md`, add one bullet to the top of the `## information-requests` section in `decisions.md`.

```bash
git add src/modules/cases/cases.workflow.service.ts test/integration/modules/cases/close.test.ts decisions.md decisions/information-requests/task-09-closure-guard.md
git commit -m "feat: closure blocked while an information request is open (VC-12)"
```

---

## Final verification

After Task 9, run the full backend suite and typecheck:

```bash
docker compose -f docker-compose.test.yml down && docker compose -f docker-compose.test.yml up -d
npx vitest run test/unit test/integration
npx tsc --noEmit
```
