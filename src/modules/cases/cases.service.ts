import type { DataSource } from 'typeorm';
import { Case } from './entities/case.entity';
import { CaseCategory } from '../master-data/entities/case-category.entity';
import { CaseType } from '../master-data/entities/case-type.entity';
import { Department } from '../master-data/entities/department.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';
import { ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';
import { computeDueDates } from './sla';
import { generateReferenceNumber } from './reference-number';
import { evaluateAutoRouting } from './auto-routing';
import { assignCase } from './cases.workflow.service';

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
    }),
  );

  await logAuditEvent(dataSource, {
    actorId: actor.id,
    caseId: caseRow.id,
    action: 'case.submitted',
    afterValue: { id: caseRow.id, referenceNumber: caseRow.referenceNumber, status: caseRow.status },
  });

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
