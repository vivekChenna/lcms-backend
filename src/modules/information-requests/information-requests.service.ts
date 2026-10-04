import type { DataSource, EntityManager } from 'typeorm';
import { InformationRequest } from './entities/information-request.entity';
import { Case } from '../cases/entities/case.entity';
import { User } from '../users/entities/user.entity';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';
import { markCaseWaitingOnInput, markCaseInProgress } from '../cases/cases.workflow.service';
import { getCaseById, type Actor } from '../cases/cases.service';

export type RaiseInformationRequestInput = {
  subject: string;
  requirementDescription: string;
  responderId: string;
  dueDate?: Date;
};

// Every mutation below runs in one transaction and takes a row lock on the
// case (SELECT ... FOR UPDATE) before reading/writing information requests,
// so (a) a failing case transition rolls back the information-request writes
// and (b) concurrent mutations on the same case serialize — e.g. two
// responses to the last two open requests can't both see "another one is
// still open" and leave the case stuck in Waiting on Input.
async function lockCaseOrThrow(manager: EntityManager, caseId: string): Promise<Case> {
  const caseRow = await manager.getRepository(Case).findOne({ where: { id: caseId }, lock: { mode: 'pessimistic_write' } });
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
  return dataSource.transaction(async (manager) => {
    const caseRow = await lockCaseOrThrow(manager, caseId);
    if (caseRow.assignedLegalRepId !== actorId) {
      throw new ForbiddenError('Only the assigned legal representative can raise an information request on this case');
    }
    if (caseRow.status !== 'In Progress' && caseRow.status !== 'Waiting on Input') {
      throw new ConflictError('Information requests can only be raised on an In Progress or Waiting on Input case');
    }

    const responder = await manager.getRepository(User).findOne({ where: { id: input.responderId } });
    if (!responder || !responder.isActive) {
      throw new ValidationError('Unknown or inactive responderId');
    }

    const repo = manager.getRepository(InformationRequest);
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

    await markCaseWaitingOnInput(manager, actorId, caseId);

    await logAuditEvent(manager, {
      actorId,
      caseId,
      action: 'info_request.raised',
      afterValue: { id: infoRequest.id, caseId, referenceNumber: caseRow.referenceNumber, responderId: infoRequest.responderId },
    });

    return infoRequest;
  });
}

async function loadInformationRequestOrThrow(manager: EntityManager, requestId: string): Promise<InformationRequest> {
  const row = await manager.getRepository(InformationRequest).findOne({ where: { id: requestId } });
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
  return dataSource.transaction(async (manager) => {
    // Unlocked read only to learn caseId; the authoritative read happens
    // after the case lock is held, so a concurrent response/reopen on the
    // same request can't slip past the status check.
    const { caseId } = await loadInformationRequestOrThrow(manager, requestId);
    const caseRow = await lockCaseOrThrow(manager, caseId);
    const infoRequest = await loadInformationRequestOrThrow(manager, requestId);
    if (infoRequest.responderId !== actorId) {
      throw new ForbiddenError('Only the assigned responder can answer this information request');
    }
    if (infoRequest.status !== 'open') {
      throw new ConflictError('This information request is not open');
    }

    const repo = manager.getRepository(InformationRequest);
    infoRequest.status = 'answered';
    infoRequest.responseText = responseText;
    await repo.save(infoRequest);

    const otherOpenCount = await repo.count({ where: { caseId, status: 'open' } });
    if (otherOpenCount === 0) {
      await markCaseInProgress(manager, actorId, caseId);
    }

    await logAuditEvent(manager, {
      actorId,
      caseId,
      action: 'info_request.answered',
      beforeValue: { id: infoRequest.id, status: 'open' },
      afterValue: {
        id: infoRequest.id,
        caseId,
        referenceNumber: caseRow.referenceNumber,
        status: infoRequest.status,
        responseText,
      },
    });

    return infoRequest;
  });
}

export async function reopenInformationRequest(
  dataSource: DataSource,
  actorId: string,
  requestId: string,
  comment: string,
): Promise<InformationRequest> {
  return dataSource.transaction(async (manager) => {
    const { caseId } = await loadInformationRequestOrThrow(manager, requestId);
    const caseRow = await lockCaseOrThrow(manager, caseId);
    const superseded = await loadInformationRequestOrThrow(manager, requestId);
    if (superseded.raisedById !== actorId) {
      throw new ForbiddenError('Only the legal representative who raised this request can reopen it');
    }
    if (superseded.status !== 'answered') {
      throw new ConflictError('Only an answered information request can be reopened');
    }
    // Checked before any write: markCaseWaitingOnInput would otherwise only
    // reject (e.g. a Closed case) after the rows below were already written.
    if (caseRow.status !== 'In Progress' && caseRow.status !== 'Waiting on Input') {
      throw new ConflictError('Cannot reopen an information request while the case is not In Progress or Waiting on Input');
    }

    const repo = manager.getRepository(InformationRequest);
    superseded.status = 'superseded';
    await repo.save(superseded);

    const reopened = await repo.save(
      repo.create({
        caseId,
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

    await markCaseWaitingOnInput(manager, actorId, caseId);

    await logAuditEvent(manager, {
      actorId,
      caseId,
      action: 'info_request.reopened',
      beforeValue: { id: superseded.id, status: 'answered', referenceNumber: caseRow.referenceNumber },
      afterValue: { id: reopened.id, caseId, reopenedFromId: superseded.id, referenceNumber: caseRow.referenceNumber },
    });

    return reopened;
  });
}

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
