import type { DataSource } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { buildPaginatedResponse, paginationToSkipTake } from '../../shared/pagination';
import { serializeAuditRows } from './audit.serialize';

const LEGAL_ROLES = new Set(['admin', 'legal_manager', 'legal_rep']);

export async function listCaseAudit(
  dataSource: DataSource,
  actor: Actor,
  caseId: string,
  query: { page: number; pageSize: number; createdFrom?: Date; createdTo?: Date },
) {
  await getCaseById(dataSource, actor, caseId); // visibility gate: 404 when the caller cannot see the case

  const qb = dataSource.getRepository(AuditLog).createQueryBuilder('a').where('a."caseId" = :caseId', { caseId });
  if (query.createdFrom) qb.andWhere('a."createdAt" >= :createdFrom', { createdFrom: query.createdFrom });
  if (query.createdTo) qb.andWhere('a."createdAt" <= :createdTo', { createdTo: query.createdTo });
  if (!LEGAL_ROLES.has(actor.role)) {
    // Requesters and viewers must not learn legal-only content: internal notes
    // (their text is stored in the audit values) and the rejection reason.
    // The isInternal check is not limited to comment.* actions so any future
    // event that carries the flag fails closed.
    qb.andWhere(`a."action" != 'case.rejected'`);
    qb.andWhere(
      `NOT (COALESCE(a."afterValue"->>'isInternal', 'false') = 'true' OR COALESCE(a."beforeValue"->>'isInternal', 'false') = 'true')`,
    );
  }

  const { skip, take } = paginationToSkipTake(query);
  const [rows, total] = await qb.orderBy('a."createdAt"', 'DESC').addOrderBy('a."id"', 'DESC').skip(skip).take(take).getManyAndCount();
  return buildPaginatedResponse(await serializeAuditRows(dataSource, rows), total, query);
}
