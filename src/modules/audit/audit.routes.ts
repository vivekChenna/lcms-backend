import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { paginationToSkipTake, buildPaginatedResponse } from '../../shared/pagination';
import { AuditLog } from './entities/audit-log.entity';
import { toCsv, sendCsv, DEFAULT_EXPORT_ROW_CAP, type CsvColumn } from '../dashboards-reports/csv';
import { auditQuerySchema, auditListResponseSchema } from './audit.schemas';

export default async function auditRoutes(app: FastifyInstance, opts: { exportRowCap?: number } = {}): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/audit', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { tags: ['Audit'], security: [{ bearerAuth: [] }], querystring: auditQuerySchema, response: { 200: auditListResponseSchema } },
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

  const AUDIT_EXPORT_COLUMNS: CsvColumn<AuditLog>[] = [
    { header: 'id', value: (row) => row.id },
    { header: 'caseId', value: (row) => row.caseId },
    { header: 'actorId', value: (row) => row.actorId },
    { header: 'action', value: (row) => row.action },
    { header: 'createdAt', value: (row) => row.createdAt },
    { header: 'beforeValue', value: (row) => row.beforeValue },
    { header: 'afterValue', value: (row) => row.afterValue },
  ];

  typedApp.get('/audit/export', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { tags: ['Audit'], security: [{ bearerAuth: [] }], querystring: auditQuerySchema.omit({ page: true, pageSize: true }) },
  }, async (request, reply) => {
    const cap = opts.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP;
    const query = request.query;
    const where: Record<string, unknown> = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.caseId) where.caseId = query.caseId;
    const repo = app.dataSource.getRepository(AuditLog);
    const total = await repo.count({ where });
    const rows = await repo.find({ where, order: { createdAt: 'DESC', id: 'DESC' }, take: cap });
    return sendCsv(reply, 'audit', toCsv(rows, AUDIT_EXPORT_COLUMNS), { total, truncated: total > rows.length });
  });
}
