import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { CaseComment } from './entities/case-comment.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { lockCaseOrThrow } from '../cases/cases.workflow.service';
import { assertCaseNotClosed, assertCaseWriteEligibility, isLegalRole } from '../cases/case-access';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
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

async function findLiveComment(source: DataSource | EntityManager, commentId: string): Promise<CaseComment> {
  const comment = await source.getRepository(CaseComment).findOne({ where: { id: commentId, deletedAt: IsNull() } });
  if (!comment) {
    throw new NotFoundError('Comment not found');
  }
  return comment;
}

// Shared by edit and delete. The first read learns the case id; everything that
// matters is re-read under the case lock. An internal note is invisible to
// non-legal roles (404, not 403); an author who has since lost their legal role
// therefore also sees 404 for their own old internal notes.
async function mutateOwnComment(
  dataSource: DataSource,
  actor: Actor,
  commentId: string,
  apply: (manager: EntityManager, comment: CaseComment, referenceNumber: string) => Promise<void>,
): Promise<void> {
  const preliminary = await findLiveComment(dataSource, commentId);
  await getCaseById(dataSource, actor, preliminary.caseId);
  if (preliminary.isInternal && !isLegalRole(actor.role)) {
    throw new NotFoundError('Comment not found');
  }
  await dataSource.transaction(async (manager) => {
    const caseRow = await lockCaseOrThrow(manager, preliminary.caseId);
    const comment = await findLiveComment(manager, commentId);
    if (actor.role === 'viewer') {
      throw new ForbiddenError('Viewers cannot change comments');
    }
    assertCaseNotClosed(caseRow);
    if (comment.authorId !== actor.id) {
      throw new ForbiddenError('Only the author can change this comment');
    }
    await apply(manager, comment, caseRow.referenceNumber);
  });
}

export async function editComment(dataSource: DataSource, actor: Actor, commentId: string, body: string): Promise<CaseComment> {
  let edited!: CaseComment;
  await mutateOwnComment(dataSource, actor, commentId, async (manager, comment, referenceNumber) => {
    const before = { id: comment.id, body: comment.body, isInternal: comment.isInternal };
    comment.body = body;
    edited = await manager.getRepository(CaseComment).save(comment);
    await logAuditEvent(manager, {
      actorId: actor.id,
      caseId: comment.caseId,
      action: 'comment.edited',
      beforeValue: before,
      afterValue: { id: comment.id, caseId: comment.caseId, referenceNumber, isInternal: comment.isInternal, body },
    });
  });
  return edited;
}

export async function deleteComment(dataSource: DataSource, actor: Actor, commentId: string): Promise<void> {
  await mutateOwnComment(dataSource, actor, commentId, async (manager, comment, referenceNumber) => {
    const before = { id: comment.id, body: comment.body, isInternal: comment.isInternal };
    comment.deletedAt = new Date();
    await manager.getRepository(CaseComment).save(comment);
    await logAuditEvent(manager, {
      actorId: actor.id,
      caseId: comment.caseId,
      action: 'comment.deleted',
      beforeValue: before,
      afterValue: { id: comment.id, caseId: comment.caseId, referenceNumber, isInternal: comment.isInternal, deletedAt: comment.deletedAt },
    });
  });
}
