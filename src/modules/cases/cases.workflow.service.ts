import type { DataSource, EntityManager } from 'typeorm';
import { Case, CaseStatus } from './entities/case.entity';
import { assertTransition } from './state-machine';
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';
import { assertValidLegalRep } from '../master-data/routing-rules.service';
import { ClosureOutcome } from '../master-data/entities/closure-outcome.entity';
import { InformationRequest } from '../information-requests/entities/information-request.entity';
import {
  notifyAssignmentRejected,
  notifyCaseAccepted,
  notifyCaseAssigned,
  notifyCaseClosed,
} from '../notifications/notifications.events';

export async function loadCaseOrThrow(dataSource: DataSource | EntityManager, caseId: string): Promise<Case> {
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
  await notifyCaseAssigned(dataSource, caseRow);
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
  await notifyCaseAccepted(dataSource, caseRow);
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
  await notifyAssignmentRejected(dataSource, caseRow, reason);
  return caseRow;
}

// Locks the case row (SELECT ... FOR UPDATE) before the VC-12 open-request
// check below, and runs the whole close inside one transaction — same
// pattern information-requests.service.ts uses for raise/respond/reopen.
// Without this, a concurrent raise (which also locks the case row, see
// information-requests.service.ts) and closeCase could each read "no open
// requests" / "case not yet Closed" before the other commits, letting both
// proceed: a case closes while an information request opens on it.
export async function lockCaseOrThrow(manager: EntityManager, caseId: string): Promise<Case> {
  const caseRow = await manager.getRepository(Case).findOne({ where: { id: caseId }, lock: { mode: 'pessimistic_write' } });
  if (!caseRow) {
    throw new NotFoundError('Case not found');
  }
  return caseRow;
}

export async function closeCase(
  dataSource: DataSource,
  actor: { id: string; role: string },
  caseId: string,
  input: { closureSummary: string; closureOutcomeId: string },
): Promise<Case> {
  return dataSource.transaction(async (manager) => {
    const caseRow = await lockCaseOrThrow(manager, caseId);
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
    const closureOutcome = await manager.getRepository(ClosureOutcome).findOne({ where: { id: input.closureOutcomeId } });
    if (!closureOutcome || !closureOutcome.isActive) {
      throw new ValidationError('Unknown or inactive closureOutcomeId');
    }

    // VC-12/WF-10: closure is blocked while any information request on this
    // case remains open. Imports only the InformationRequest entity (a leaf
    // module with no dependency back on cases), not its service — avoids the
    // real cycle risk, which is between the two service files, not the entity.
    const openRequestCount = await manager.getRepository(InformationRequest).count({
      where: { caseId: caseRow.id, status: 'open' },
    });
    if (openRequestCount > 0) {
      throw new ConflictError('Case cannot be closed while an information request is still open (VC-12)');
    }

    const before = { id: caseRow.id, status: caseRow.status };
    caseRow.status = 'Closed';
    caseRow.closureSummary = input.closureSummary;
    caseRow.closureOutcomeId = input.closureOutcomeId;
    caseRow.closedById = actor.id;
    caseRow.closedAt = new Date();
    await manager.getRepository(Case).save(caseRow);
    await logAuditEvent(manager, {
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
    await notifyCaseClosed(manager, caseRow);
    return caseRow;
  });
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

// Accepts an EntityManager so information-request mutations can run this
// inside their own transaction; a plain DataSource still works.
export async function markCaseWaitingOnInput(
  dataSource: DataSource | EntityManager,
  actorId: string,
  caseId: string,
): Promise<Case> {
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

// Restricted to Waiting on Input -> In Progress (plus a no-op when already
// In Progress). The state machine also allows Assigned -> In Progress, but
// that edge belongs to acceptAssignment (sets assignmentAcceptedAt, audits
// case.accepted) and must not be reachable through this helper.
export async function markCaseInProgress(
  dataSource: DataSource | EntityManager,
  actorId: string,
  caseId: string,
): Promise<Case> {
  const caseRow = await loadCaseOrThrow(dataSource, caseId);
  if (caseRow.status === 'In Progress') {
    return caseRow;
  }
  if (caseRow.status !== 'Waiting on Input') {
    throw new ConflictError(`Cannot resume case to 'In Progress' from '${caseRow.status}'; only a Waiting on Input case can be resumed`);
  }
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
