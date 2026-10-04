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
