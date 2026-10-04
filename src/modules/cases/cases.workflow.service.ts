import type { DataSource } from 'typeorm';
import { Case, CaseStatus } from './entities/case.entity';
import { assertTransition } from './state-machine';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';
import { assertValidLegalRep } from '../master-data/routing-rules.service';
import { ClosureOutcome } from '../master-data/entities/closure-outcome.entity';

export async function loadCaseOrThrow(dataSource: DataSource, caseId: string): Promise<Case> {
  const caseRow = await dataSource.getRepository(Case).findOne({ where: { id: caseId } });
  if (!caseRow) {
    throw new NotFoundError('Case not found');
  }
  return caseRow;
}

export async function assignCase(
  dataSource: DataSource,
  actorId: string,
  caseId: string,
  targetLegalRepId: string,
  auditAction: string = 'case.assigned',
): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  assertTransition(caseRow.status as CaseStatus, 'Assigned');
  await assertValidLegalRep(dataSource, targetLegalRepId);

  const before = { id: caseRow.id, status: caseRow.status, assignedLegalRepId: caseRow.assignedLegalRepId };
  caseRow.status = 'Assigned';
  caseRow.assignedLegalRepId = targetLegalRepId;
  caseRow.assignmentAcceptedAt = null;

  const repo = dataSource.getRepository(Case);
  await repo.save(caseRow);
  await logAuditEvent(dataSource, {
    actorId,
    caseId: caseRow.id,
    action: auditAction,
    beforeValue: before,
    afterValue: {
      id: caseRow.id,
      status: caseRow.status,
      assignedLegalRepId: caseRow.assignedLegalRepId,
      referenceNumber: caseRow.referenceNumber,
    },
  });
  return caseRow;
}

export async function acceptAssignment(dataSource: DataSource, actorId: string, caseId: string): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  if (caseRow.assignedLegalRepId !== actorId) {
    throw new ForbiddenError('Only the assigned legal representative can accept this case');
  }
  assertTransition(caseRow.status as CaseStatus, 'In Progress');

  const before = { id: caseRow.id, status: caseRow.status };
  caseRow.status = 'In Progress';
  caseRow.assignmentAcceptedAt = new Date();
  await dataSource.getRepository(Case).save(caseRow);
  await logAuditEvent(dataSource, {
    actorId,
    caseId: caseRow.id,
    action: 'case.accepted',
    beforeValue: before,
    afterValue: { id: caseRow.id, status: caseRow.status, referenceNumber: caseRow.referenceNumber },
  });
  return caseRow;
}

export async function rejectAssignment(dataSource: DataSource, actorId: string, caseId: string, reason: string): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  if (caseRow.assignedLegalRepId !== actorId) {
    throw new ForbiddenError('Only the assigned legal representative can reject this case');
  }
  assertTransition(caseRow.status as CaseStatus, 'Submitted');

  const before = { id: caseRow.id, status: caseRow.status, assignedLegalRepId: caseRow.assignedLegalRepId };
  caseRow.status = 'Submitted';
  caseRow.assignedLegalRepId = null;
  caseRow.assignmentAcceptedAt = null;
  await dataSource.getRepository(Case).save(caseRow);
  await logAuditEvent(dataSource, {
    actorId,
    caseId: caseRow.id,
    action: 'case.rejected',
    beforeValue: before,
    afterValue: { id: caseRow.id, status: caseRow.status, reason, referenceNumber: caseRow.referenceNumber },
  });
  return caseRow;
}

// VC-12's "no open information requests" guard is deferred to sub-project 2
// (that table doesn't exist yet) — see spec §3/§8.
export async function closeCase(
  dataSource: DataSource,
  actor: { id: string; role: string },
  caseId: string,
  input: { closureSummary: string; closureOutcomeId: string },
): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  // Transition validity is checked before authorization (unlike setEscalation,
  // which has no transition to check): a case still Submitted has no assigned
  // rep yet, so checking ownership first would misreport VC-14's "wrong status"
  // case as a 403 instead of the intended 409. See decisions/case-core/task-12-closure.md.
  assertTransition(caseRow.status as CaseStatus, 'Closed');
  const isOwningRep = caseRow.assignedLegalRepId === actor.id;
  const isManagerOrAdmin = actor.role === 'legal_manager' || actor.role === 'admin';
  if (!isOwningRep && !isManagerOrAdmin) {
    throw new ForbiddenError('Only the assigned legal representative or a legal manager can close this case');
  }

  // An unknown/inactive closureOutcomeId would otherwise only be caught by
  // the database's foreign-key constraint (Postgres 23503), which the error
  // handler doesn't map to a client error, surfacing as a raw 500. Validate
  // it up front instead, matching the pattern submitCase uses for its other
  // master-data foreign keys.
  const closureOutcome = await dataSource.getRepository(ClosureOutcome).findOne({ where: { id: input.closureOutcomeId } });
  if (!closureOutcome || !closureOutcome.isActive) {
    throw new ValidationError('Unknown or inactive closureOutcomeId');
  }

  const before = { id: caseRow.id, status: caseRow.status };
  caseRow.status = 'Closed';
  caseRow.closureSummary = input.closureSummary;
  caseRow.closureOutcomeId = input.closureOutcomeId;
  caseRow.closedById = actor.id;
  caseRow.closedAt = new Date();
  await dataSource.getRepository(Case).save(caseRow);
  await logAuditEvent(dataSource, {
    actorId: actor.id,
    caseId: caseRow.id,
    action: 'case.closed',
    beforeValue: before,
    afterValue: {
      id: caseRow.id,
      status: caseRow.status,
      closureOutcomeId: caseRow.closureOutcomeId,
      referenceNumber: caseRow.referenceNumber,
    },
  });
  return caseRow;
}

export async function setEscalation(
  dataSource: DataSource,
  actor: { id: string; role: string },
  caseId: string,
  isEscalated: boolean,
  reason?: string,
): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  const isOwningRep = caseRow.assignedLegalRepId === actor.id;
  const isManagerOrAdmin = actor.role === 'legal_manager' || actor.role === 'admin';
  if (!isOwningRep && !isManagerOrAdmin) {
    throw new ForbiddenError('Only the assigned legal representative or a legal manager can change escalation state');
  }

  const before = { id: caseRow.id, isEscalated: caseRow.isEscalated, escalationReason: caseRow.escalationReason };
  caseRow.isEscalated = isEscalated;
  caseRow.escalationReason = isEscalated ? (reason ?? null) : null;
  await dataSource.getRepository(Case).save(caseRow);
  await logAuditEvent(dataSource, {
    actorId: actor.id,
    caseId: caseRow.id,
    action: isEscalated ? 'case.escalated' : 'case.escalation_cleared',
    beforeValue: before,
    afterValue: {
      id: caseRow.id,
      isEscalated: caseRow.isEscalated,
      escalationReason: caseRow.escalationReason,
      referenceNumber: caseRow.referenceNumber,
    },
  });
  return caseRow;
}
