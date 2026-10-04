import type { DataSource } from 'typeorm';
import { Case, CaseStatus } from './entities/case.entity';
import { assertTransition } from './state-machine';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';
import { assertValidLegalRep } from '../master-data/routing-rules.service';

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
