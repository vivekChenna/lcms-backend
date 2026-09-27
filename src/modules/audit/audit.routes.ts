import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { paginationToSkipTake, buildPaginatedResponse } from '../../shared/pagination';
import { AuditLog } from './entities/audit-log.entity';
import { auditQuerySchema, auditListResponseSchema } from './audit.schemas';

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/audit', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { querystring: auditQuerySchema, response: { 200: auditListResponseSchema } },
  }, async (request) => {
    const query = request.query;
    const repo = app.dataSource.getRepository(AuditLog);
    const { skip, take } = paginationToSkipTake(query);

    const where: Record<string, unknown> = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.caseId) where.caseId = query.caseId;

    const [rows, total] = await repo.findAndCount({ where, skip, take, order: { createdAt: 'DESC' } });
    const items = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return buildPaginatedResponse(items, total, query);
  });
}
