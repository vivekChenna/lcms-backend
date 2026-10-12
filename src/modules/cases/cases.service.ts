import type { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { Case } from './entities/case.entity';
import { CaseCategory } from '../master-data/entities/case-category.entity';
import { CaseType } from '../master-data/entities/case-type.entity';
import { Department } from '../master-data/entities/department.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';
import { computeDueDates, toCaseWithSla } from './sla';
import { generateReferenceNumber } from './reference-number';
import { evaluateAutoRouting } from './auto-routing';
import { assignCase } from './cases.workflow.service';
import { notifyCaseRegistered, notifyTargetDatesChanged } from '../notifications/notifications.events';
import { PaginationQuery, paginationToSkipTake } from '../../shared/pagination';
import { InformationRequest } from '../information-requests/entities/information-request.entity';

export type CreateCaseInput = {
  title: string;
  description: string;
  declarationConfirmed: true;
  categoryId: string;
  caseTypeId: string;
  departmentId: string;
  // Optional here to mirror createCaseBodySchema (cases.schemas.ts): a
  // requester never supplies this (it's pre-filled from their profile below),
  // while other submitter roles must. Enforced below, not at the type level.
  entityId?: string;
  businessUnitId?: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  isConfidential?: boolean;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  desiredOutcome?: string;
  incidentDate?: string;
  businessDeadline?: string;
  counterparty?: string;
  estimatedValue?: number;
  thirdPartyDetails?: string;
};

export type Actor = { id: string; role: string; departmentId: string | null; entityId: string | null; businessUnitId: string | null };

export async function submitCase(dataSource: DataSource, actor: Actor, input: CreateCaseInput): Promise<Case> {
  const category = await dataSource.getRepository(CaseCategory).findOne({ where: { id: input.categoryId } });
  if (!category || !category.isActive) {
    throw new ValidationError('Unknown or inactive categoryId');
  }
  if (actor.role === 'requester' && category.name !== 'Internal') {
    throw new ValidationError('Requesters may only submit cases in the Internal category (VC-03)');
  }

  const caseType = await dataSource.getRepository(CaseType).findOne({ where: { id: input.caseTypeId } });
  if (!caseType || !caseType.isActive) {
    throw new ValidationError('Unknown or inactive caseTypeId');
  }
  if (caseType.categoryId !== input.categoryId) {
    throw new ValidationError('caseTypeId does not belong to the submitted categoryId (VC-04)');
  }

  const department = await dataSource.getRepository(Department).findOne({ where: { id: input.departmentId } });
  if (!department || !department.isActive) {
    throw new ValidationError('Unknown or inactive departmentId');
  }

  // Requester's entity/business unit are pre-filled from their profile and
  // non-editable (PR-02); other submitter roles provide them directly.
  let entityId: string;
  let businessUnitId = input.businessUnitId ?? null;
  if (actor.role === 'requester') {
    if (!actor.entityId) {
      throw new ValidationError('Requester profile has no entity assigned');
    }
    entityId = actor.entityId;
    businessUnitId = actor.businessUnitId;
  } else {
    if (!input.entityId) {
      throw new ValidationError('entityId is required');
    }
    entityId = input.entityId;
  }

  const entity = await dataSource.getRepository(OrgEntity).findOne({ where: { id: entityId } });
  if (!entity || !entity.isActive) {
    throw new ValidationError('Unknown or inactive entityId');
  }

  if (businessUnitId) {
    const businessUnit = await dataSource.getRepository(BusinessUnit).findOne({ where: { id: businessUnitId } });
    if (!businessUnit || !businessUnit.isActive) {
      throw new ValidationError('Unknown or inactive businessUnitId');
    }
    if (businessUnit.entityId !== entityId) {
      throw new ValidationError('businessUnitId does not belong to the submitted entityId (VC-05)');
    }
  }

  const submittedAt = new Date();
  const { ackDueAt, resolutionDueAt } = computeDueDates(submittedAt, caseType.slaAckHours, caseType.slaResolutionHours);

  const [{ seq }] = await dataSource.query(`SELECT nextval('case_reference_seq') AS seq`);
  const referenceNumber = generateReferenceNumber(entity.code, caseType.name, Number(seq));

  const repo = dataSource.getRepository(Case);
  const caseRow = await repo.save(
    repo.create({
      referenceNumber,
      title: input.title,
      description: input.description,
      declarationConfirmed: input.declarationConfirmed,
      categoryId: input.categoryId,
      caseTypeId: input.caseTypeId,
      departmentId: input.departmentId,
      entityId,
      businessUnitId,
      priority: input.priority,
      status: 'Submitted',
      isEscalated: false,
      escalationReason: null,
      waitingOnReason: null,
      requesterId: actor.id,
      assignedLegalRepId: null,
      assignmentAcceptedAt: null,
      ackDueAt,
      resolutionDueAt,
      slaBreachNotifiedAt: null,
      closureSummary: null,
      closureOutcomeId: null,
      closedById: null,
      closedAt: null,
      isConfidential: input.isConfidential ?? false,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      desiredOutcome: input.desiredOutcome ?? null,
      incidentDate: input.incidentDate ?? null,
      businessDeadline: input.businessDeadline ?? null,
      counterparty: input.counterparty ?? null,
      estimatedValue: input.estimatedValue ?? null,
      thirdPartyDetails: input.thirdPartyDetails ?? null,
    }),
  );

  await logAuditEvent(dataSource, {
    actorId: actor.id,
    caseId: caseRow.id,
    action: 'case.submitted',
    afterValue: { id: caseRow.id, referenceNumber: caseRow.referenceNumber, status: caseRow.status },
  });
  await notifyCaseRegistered(dataSource, caseRow);

  const match = await evaluateAutoRouting(dataSource, {
    categoryId: caseRow.categoryId,
    caseTypeId: caseRow.caseTypeId,
    entityId: caseRow.entityId,
    businessUnitId: caseRow.businessUnitId,
    departmentId: caseRow.departmentId,
    priority: caseRow.priority,
  });
  if (match) {
    return assignCase(dataSource, actor.id, caseRow.id, match.targetLegalRepId, 'case.auto_assigned');
  }

  return caseRow;
}

export type CaseFilterQuery = {
  status?: string;
  priority?: string;
  categoryId?: string;
  caseTypeId?: string;
  entityId?: string;
  businessUnitId?: string;
  departmentId?: string;
  assignedLegalRepId?: string;
  search?: string;
  slaState?: 'on_track' | 'at_risk' | 'breached' | 'met';
  open?: boolean;
};

export type CaseListQuery = PaginationQuery & CaseFilterQuery;

export const SLA_STATE_CONDITIONS: Record<string, string> = {
  met: `"status" = 'Closed' AND "closedAt" <= "resolutionDueAt"`,
  breached: `(("status" != 'Closed' AND "resolutionDueAt" < NOW()) OR ("status" = 'Closed' AND "closedAt" > "resolutionDueAt"))`,
  at_risk: `"status" != 'Closed' AND "resolutionDueAt" >= NOW() AND ("resolutionDueAt" - NOW()) <= ("resolutionDueAt" - "createdAt") * 0.2`,
  on_track: `"status" != 'Closed' AND ("resolutionDueAt" - NOW()) > ("resolutionDueAt" - "createdAt") * 0.2`,
};

// Shared by the case list, the case export, the dashboard and the reports so a
// tile, a chart bar, a CSV row and a list row can never disagree. The query
// builder must use the alias "c".
export function applyCaseFilters(qb: SelectQueryBuilder<Case>, actor: Actor, query: CaseFilterQuery): void {
  // Alias is "c", not "case": "case" is a fully reserved PostgreSQL keyword
  // (the CASE WHEN expression), and TypeORM only auto-quotes an
  // alias.property reference when the property itself is left bare (e.g.
  // `case.status`) — its placeholder-replacement regex doesn't recognize an
  // already-quoted property name (e.g. `case."departmentId"`), so that form
  // is sent to Postgres with the alias still unquoted and fails with a
  // "syntax error at or near \".\"" (reproduced while implementing this
  // task: the department-scoped requester filter below is the first one any
  // test exercises that uses a camelCase, quotes-required column name).
  // Visibility: the same rule as canActorSeeCase below, which must stay in step.
  if (actor.role === 'viewer') {
    qb.andWhere('c."isConfidential" = false');
  }
  if (actor.role === 'requester') {
    qb.andWhere(
      `((c."departmentId" = :actorDepartmentId AND c."isConfidential" = false)
        OR c."requesterId" = :actorId
        OR EXISTS (SELECT 1 FROM information_requests ir WHERE ir."caseId" = c.id AND ir."responderId" = :actorId))`,
      { actorDepartmentId: actor.departmentId, actorId: actor.id },
    );
  }

  if (query.status) qb.andWhere('c."status" = :status', { status: query.status });
  if (query.priority) qb.andWhere('c."priority" = :priority', { priority: query.priority });
  if (query.categoryId) qb.andWhere('c."categoryId" = :categoryId', { categoryId: query.categoryId });
  if (query.caseTypeId) qb.andWhere('c."caseTypeId" = :caseTypeId', { caseTypeId: query.caseTypeId });
  if (query.entityId) qb.andWhere('c."entityId" = :entityId', { entityId: query.entityId });
  if (query.businessUnitId) qb.andWhere('c."businessUnitId" = :businessUnitId', { businessUnitId: query.businessUnitId });
  if (query.departmentId) qb.andWhere('c."departmentId" = :departmentId', { departmentId: query.departmentId });
  if (query.assignedLegalRepId) qb.andWhere('c."assignedLegalRepId" = :assignedLegalRepId', { assignedLegalRepId: query.assignedLegalRepId });
  if (query.search) {
    qb.andWhere('(c."title" ILIKE :search OR c."description" ILIKE :search OR c."referenceNumber" ILIKE :search)', {
      search: `%${query.search}%`,
    });
  }
  if (query.slaState) {
    qb.andWhere(SLA_STATE_CONDITIONS[query.slaState]);
  }
  if (query.open) {
    qb.andWhere(`c."status" != 'Closed'`);
  }
}

export async function listCases(
  dataSource: DataSource,
  actor: Actor,
  query: CaseListQuery,
): Promise<{ items: ReturnType<typeof toCaseWithSla>[]; total: number; page: number; pageSize: number }> {
  const { skip, take } = paginationToSkipTake(query);
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');

  applyCaseFilters(qb, actor, query);

  const total = await qb.getCount();
  const rows = await qb.orderBy('c."createdAt"', 'DESC').skip(skip).take(take).getMany();

  return { items: rows.map((row) => toCaseWithSla(row)), total, page: query.page, pageSize: query.pageSize };
}

export async function listCasesForExport(
  dataSource: DataSource,
  actor: Actor,
  query: CaseFilterQuery,
  limit: number,
): Promise<{ rows: ReturnType<typeof toCaseWithSla>[]; total: number }> {
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');
  applyCaseFilters(qb, actor, query);
  const total = await qb.getCount();
  const rows = await qb.orderBy('c."createdAt"', 'DESC').addOrderBy('c."id"', 'DESC').limit(limit).getMany();
  return { rows: rows.map((row) => toCaseWithSla(row)), total };
}

// Single-case counterpart of the visibility block in applyCaseFilters; the two
// must stay in step. A confidential case is hidden from viewers and from
// requesters who neither submitted it nor answer an information request on it.
export async function canActorSeeCase(source: DataSource | EntityManager, actor: Actor, caseRow: Case): Promise<boolean> {
  if (actor.role === 'viewer') {
    return !caseRow.isConfidential;
  }
  if (actor.role !== 'requester') {
    return true;
  }
  if (caseRow.requesterId === actor.id) {
    return true;
  }
  if (caseRow.departmentId === actor.departmentId && !caseRow.isConfidential) {
    return true;
  }
  // AC-04: a requester also sees a case when an information request on it is
  // assigned to them as responder.
  // Imports only the InformationRequest entity (a leaf module with no
  // dependency back on cases), not its service — the real import-cycle
  // risk is between the two service files (information-requests.service.ts
  // imports cases.service.ts), not the entity, so this repository call is
  // safe and keeps the module graph one-directional at the service level.
  const count = await source.getRepository(InformationRequest).count({ where: { caseId: caseRow.id, responderId: actor.id } });
  return count > 0;
}

export async function getCaseById(dataSource: DataSource, actor: Actor, caseId: string) {
  const caseRow = await dataSource.getRepository(Case).findOne({ where: { id: caseId } });
  if (!caseRow) {
    throw new NotFoundError('Case not found');
  }
  if (!(await canActorSeeCase(dataSource, actor, caseRow))) {
    throw new NotFoundError('Case not found');
  }
  return toCaseWithSla(caseRow);
}

export type UpdateCaseInput = {
  title?: string;
  description?: string;
  categoryId?: string;
  caseTypeId?: string;
  departmentId?: string;
  isConfidential?: boolean;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  desiredOutcome?: string | null;
  incidentDate?: string | null;
  businessDeadline?: string | null;
  counterparty?: string | null;
  estimatedValue?: number | null;
  thirdPartyDetails?: string | null;
};

export async function updateCase(dataSource: DataSource, actor: Actor, caseId: string, input: UpdateCaseInput): Promise<Case> {
  const repo = dataSource.getRepository(Case);
  const caseRow = await repo.findOne({ where: { id: caseId } });
  // A case the actor cannot see answers 404, not 403, so the attempt does not
  // confirm that a hidden confidential case exists.
  if (!caseRow || !(await canActorSeeCase(dataSource, actor, caseRow))) {
    throw new NotFoundError('Case not found');
  }
  if (caseRow.requesterId !== actor.id && actor.role !== 'admin') {
    throw new ForbiddenError('Only the submitter or an admin can edit this case');
  }
  if (caseRow.status !== 'Submitted') {
    throw new ConflictError('Case can only be edited while Submitted');
  }
  if (input.categoryId !== undefined) {
    const category = await dataSource.getRepository(CaseCategory).findOne({ where: { id: input.categoryId } });
    if (!category || !category.isActive) {
      throw new ValidationError('Unknown or inactive categoryId');
    }
    // VC-03: requesters may only ever have cases in the Internal category.
    // submitCase already enforces this at creation time; re-checking here
    // closes the gap where a requester submits an Internal case and then
    // PATCHes categoryId to move it out of Internal.
    if (actor.role === 'requester' && category.name !== 'Internal') {
      throw new ValidationError('Requesters may only edit cases into the Internal category (VC-03)');
    }
  }
  const effectiveCategoryId = input.categoryId ?? caseRow.categoryId;
  // VC-04: re-validate whenever EITHER categoryId or caseTypeId is present in
  // the input, not only when caseTypeId itself changed -- changing just the
  // category can just as easily orphan the case's existing caseTypeId.
  if (input.categoryId !== undefined || input.caseTypeId !== undefined) {
    const effectiveCaseTypeId = input.caseTypeId ?? caseRow.caseTypeId;
    const caseType = await dataSource.getRepository(CaseType).findOne({ where: { id: effectiveCaseTypeId } });
    if (!caseType || !caseType.isActive) {
      throw new ValidationError('Unknown or inactive caseTypeId');
    }
    if (caseType.categoryId !== effectiveCategoryId) {
      throw new ValidationError('caseTypeId does not belong to the submitted categoryId (VC-04)');
    }
  }
  if (input.departmentId) {
    const department = await dataSource.getRepository(Department).findOne({ where: { id: input.departmentId } });
    if (!department || !department.isActive) {
      throw new ValidationError('Unknown or inactive departmentId');
    }
  }

  const before = {
    id: caseRow.id,
    title: caseRow.title,
    description: caseRow.description,
    categoryId: caseRow.categoryId,
    caseTypeId: caseRow.caseTypeId,
    departmentId: caseRow.departmentId,
    isConfidential: caseRow.isConfidential,
    contactName: caseRow.contactName,
    contactEmail: caseRow.contactEmail,
    contactPhone: caseRow.contactPhone,
    desiredOutcome: caseRow.desiredOutcome,
    incidentDate: caseRow.incidentDate,
    businessDeadline: caseRow.businessDeadline,
    counterparty: caseRow.counterparty,
    estimatedValue: caseRow.estimatedValue,
    thirdPartyDetails: caseRow.thirdPartyDetails,
  };

  if (input.title !== undefined) caseRow.title = input.title;
  if (input.description !== undefined) caseRow.description = input.description;
  if (input.categoryId !== undefined) caseRow.categoryId = input.categoryId;
  if (input.caseTypeId !== undefined) caseRow.caseTypeId = input.caseTypeId;
  if (input.departmentId !== undefined) caseRow.departmentId = input.departmentId;
  if (input.isConfidential !== undefined) caseRow.isConfidential = input.isConfidential;
  if (input.contactName !== undefined) caseRow.contactName = input.contactName;
  if (input.contactEmail !== undefined) caseRow.contactEmail = input.contactEmail;
  if (input.contactPhone !== undefined) caseRow.contactPhone = input.contactPhone;
  if (input.desiredOutcome !== undefined) caseRow.desiredOutcome = input.desiredOutcome;
  if (input.incidentDate !== undefined) caseRow.incidentDate = input.incidentDate;
  if (input.businessDeadline !== undefined) caseRow.businessDeadline = input.businessDeadline;
  if (input.counterparty !== undefined) caseRow.counterparty = input.counterparty;
  if (input.estimatedValue !== undefined) caseRow.estimatedValue = input.estimatedValue;
  if (input.thirdPartyDetails !== undefined) caseRow.thirdPartyDetails = input.thirdPartyDetails;

  await repo.save(caseRow);
  await logAuditEvent(dataSource, {
    actorId: actor.id,
    caseId: caseRow.id,
    action: 'case.updated',
    beforeValue: before,
    afterValue: {
      id: caseRow.id,
      title: caseRow.title,
      description: caseRow.description,
      categoryId: caseRow.categoryId,
      caseTypeId: caseRow.caseTypeId,
      departmentId: caseRow.departmentId,
      isConfidential: caseRow.isConfidential,
      contactName: caseRow.contactName,
      contactEmail: caseRow.contactEmail,
      contactPhone: caseRow.contactPhone,
      desiredOutcome: caseRow.desiredOutcome,
      incidentDate: caseRow.incidentDate,
      businessDeadline: caseRow.businessDeadline,
      counterparty: caseRow.counterparty,
      estimatedValue: caseRow.estimatedValue,
      thirdPartyDetails: caseRow.thirdPartyDetails,
      referenceNumber: caseRow.referenceNumber,
    },
  });
  return caseRow;
}

export type UpdateTargetDatesInput = { ackDueAt?: Date; resolutionDueAt?: Date; reason: string };

// A manager or admin moves a case's deadlines (PR-19), e.g. when the work is agreed to take longer.
// The change is audited with its reason. Both dates must fall after the case was created and the
// acknowledgement date may not be after the resolution date.
export async function updateTargetDates(
  dataSource: DataSource,
  actorId: string,
  caseId: string,
  input: UpdateTargetDatesInput,
): Promise<Case> {
  const repo = dataSource.getRepository(Case);
  const caseRow = await repo.findOne({ where: { id: caseId } });
  if (!caseRow) {
    throw new NotFoundError('Case not found');
  }
  if (caseRow.status === 'Closed') {
    throw new ConflictError('Cannot change the target dates of a Closed case');
  }

  const ackDueAt = input.ackDueAt ?? caseRow.ackDueAt;
  const resolutionDueAt = input.resolutionDueAt ?? caseRow.resolutionDueAt;
  if (ackDueAt.getTime() <= caseRow.createdAt.getTime() || resolutionDueAt.getTime() <= caseRow.createdAt.getTime()) {
    throw new ValidationError('Target dates must be after the case was created');
  }
  if (ackDueAt.getTime() > resolutionDueAt.getTime()) {
    throw new ValidationError('The acknowledgement date cannot be after the resolution date');
  }

  const before = { id: caseRow.id, ackDueAt: caseRow.ackDueAt, resolutionDueAt: caseRow.resolutionDueAt };
  caseRow.ackDueAt = ackDueAt;
  caseRow.resolutionDueAt = resolutionDueAt;
  await repo.save(caseRow);
  await logAuditEvent(dataSource, {
    actorId,
    caseId: caseRow.id,
    action: 'case.target_dates_changed',
    beforeValue: before,
    afterValue: {
      id: caseRow.id,
      ackDueAt: caseRow.ackDueAt,
      resolutionDueAt: caseRow.resolutionDueAt,
      reason: input.reason,
      referenceNumber: caseRow.referenceNumber,
    },
  });
  await notifyTargetDatesChanged(dataSource, caseRow, actorId, input.reason);
  return caseRow;
}

export async function updatePriority(
  dataSource: DataSource,
  actorId: string,
  caseId: string,
  priority: Case['priority'],
): Promise<Case> {
  const repo = dataSource.getRepository(Case);
  const caseRow = await repo.findOne({ where: { id: caseId } });
  if (!caseRow) {
    throw new NotFoundError('Case not found');
  }
  if (caseRow.status === 'Closed') {
    throw new ConflictError('Cannot change priority on a Closed case');
  }

  const before = { id: caseRow.id, priority: caseRow.priority };
  caseRow.priority = priority;
  await repo.save(caseRow);
  await logAuditEvent(dataSource, {
    actorId,
    caseId: caseRow.id,
    action: 'case.priority_changed',
    beforeValue: before,
    afterValue: { id: caseRow.id, priority: caseRow.priority, referenceNumber: caseRow.referenceNumber },
  });
  return caseRow;
}
