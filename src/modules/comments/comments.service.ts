import { IsNull, type DataSource } from 'typeorm';
import { CaseComment } from './entities/case-comment.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { lockCaseOrThrow } from '../cases/cases.workflow.service';
import { assertCaseWriteEligibility, isLegalRole } from '../cases/case-access';
import { ForbiddenError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

export async function createComment(
  dataSource: DataSource,
  actor: Actor,
  caseId: string,
  input: { body: string; isInternal: boolean },
): Promise<CaseComment> {
  await getCaseById(dataSource, actor, caseId);
  return dataSource.transaction(async (manager) => {
    const caseRow = await lockCaseOrThrow(manager, caseId);
    assertCaseWriteEligibility(actor, caseRow);
    if (input.isInternal && !isLegalRole(actor.role)) {
      throw new ForbiddenError('Only legal roles can create internal notes');
    }

    const repo = manager.getRepository(CaseComment);
    const comment = await repo.save(
      repo.create({ caseId, authorId: actor.id, body: input.body, isInternal: input.isInternal, deletedAt: null }),
    );
    await logAuditEvent(manager, {
      actorId: actor.id,
      caseId,
      action: 'comment.created',
      afterValue: { id: comment.id, caseId, referenceNumber: caseRow.referenceNumber, isInternal: comment.isInternal, body: comment.body },
    });
    return comment;
  });
}

export async function listComments(dataSource: DataSource, actor: Actor, caseId: string): Promise<CaseComment[]> {
  await getCaseById(dataSource, actor, caseId);
  const where = isLegalRole(actor.role)
    ? { caseId, deletedAt: IsNull() }
    : { caseId, deletedAt: IsNull(), isInternal: false };
  return dataSource.getRepository(CaseComment).find({ where, order: { createdAt: 'ASC' } });
}
