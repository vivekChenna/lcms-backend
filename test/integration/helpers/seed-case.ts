import crypto from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Case } from '../../../src/modules/cases/entities/case.entity';

export async function seedCaseMasterData(dataSource: DataSource): Promise<{
  categoryId: string;
  caseTypeId: string;
  departmentId: string;
  entityId: string;
  businessUnitId: string;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [category] = await dataSource.query(
    `INSERT INTO case_categories (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [`Category-${suffix}`],
  );
  const [caseType] = await dataSource.query(
    `INSERT INTO case_types (id, "categoryId", name, "slaAckHours", "slaResolutionHours") VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [category.id, `Type-${suffix}`, 24, 72],
  );
  const [department] = await dataSource.query(
    `INSERT INTO departments (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [`Dept-${suffix}`],
  );
  const [entity] = await dataSource.query(
    `INSERT INTO entities (id, name, code) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [`Entity-${suffix}`, `E${suffix.toUpperCase()}`],
  );
  const [businessUnit] = await dataSource.query(
    `INSERT INTO business_units (id, "entityId", name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [entity.id, `BU-${suffix}`],
  );
  return {
    categoryId: category.id,
    caseTypeId: caseType.id,
    departmentId: department.id,
    entityId: entity.id,
    businessUnitId: businessUnit.id,
  };
}

function mustProvide(field: string): never {
  throw new Error(`seedCase: ${field} is required`);
}

export async function seedCase(
  dataSource: DataSource,
  overrides: Partial<{
    referenceNumber: string;
    title: string;
    description: string;
    categoryId: string;
    caseTypeId: string;
    departmentId: string;
    entityId: string;
    businessUnitId: string | null;
    priority: Case['priority'];
    status: Case['status'];
    requesterId: string;
    assignedLegalRepId: string | null;
    assignmentAcceptedAt: Date | null;
    isEscalated: boolean;
    escalationReason: string | null;
    slaAckHours: number;
    slaResolutionHours: number;
    submittedAt: Date;
  }> = {},
): Promise<Case> {
  // Inlined rather than importing computeDueDates from ./sla — Task 4 (sla.ts)
  // is sequenced after this task, and a fixture used by every later task's
  // tests must not depend on code that doesn't exist yet. Task 4's own unit
  // tests cover computeDueDates directly; this duplicate arithmetic is the
  // deliberate decoupling (ruling recorded in the SDD ledger).
  const submittedAt = overrides.submittedAt ?? new Date();
  const HOUR_MS = 60 * 60 * 1000;
  const ackDueAt = new Date(submittedAt.getTime() + (overrides.slaAckHours ?? 24) * HOUR_MS);
  const resolutionDueAt = new Date(submittedAt.getTime() + (overrides.slaResolutionHours ?? 72) * HOUR_MS);
  const repo = dataSource.getRepository(Case);
  const caseRow = repo.create({
    referenceNumber: overrides.referenceNumber ?? `TEST-GEN-${crypto.randomUUID().slice(0, 6)}`,
    title: overrides.title ?? 'Test case',
    description: overrides.description ?? 'A test case description that is at least twenty characters long.',
    declarationConfirmed: true,
    categoryId: overrides.categoryId ?? mustProvide('categoryId'),
    caseTypeId: overrides.caseTypeId ?? mustProvide('caseTypeId'),
    departmentId: overrides.departmentId ?? mustProvide('departmentId'),
    entityId: overrides.entityId ?? mustProvide('entityId'),
    businessUnitId: overrides.businessUnitId ?? null,
    priority: overrides.priority ?? 'P3',
    status: overrides.status ?? 'Submitted',
    isEscalated: overrides.isEscalated ?? false,
    escalationReason: overrides.escalationReason ?? null,
    waitingOnReason: null,
    requesterId: overrides.requesterId ?? mustProvide('requesterId'),
    assignedLegalRepId: overrides.assignedLegalRepId ?? null,
    assignmentAcceptedAt: overrides.assignmentAcceptedAt ?? null,
    ackDueAt,
    resolutionDueAt,
    slaBreachNotifiedAt: null,
    closureSummary: null,
    closureOutcomeId: null,
    closedById: null,
    closedAt: null,
  });
  return repo.save(caseRow);
}
