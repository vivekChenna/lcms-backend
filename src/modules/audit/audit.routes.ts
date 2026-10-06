import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../shared/rbac';
import { paginationToSkipTake, buildPaginatedResponse, paginationQuerySchema } from '../../shared/pagination';
import { AuditLog } from './entities/audit-log.entity';
import { toCsv, sendCsv, DEFAULT_EXPORT_ROW_CAP, type CsvColumn } from '../dashboards-reports/csv';
import { auditQuerySchema, auditExportQuerySchema, auditListResponseSchema, dateOrder, dateOrderMessage } from './audit.schemas';
import { serializeAuditRows, type AuditRowResponse } from './audit.serialize';
import { listCaseAudit } from './case-audit.service';
import { caseIdParamsSchema } from '../cases/cases.schemas';

export default async function auditRoutes(app: FastifyInstance, opts: { exportRowCap?: number } = {}): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  type AuditFilters = { actorId?: string; action?: string; caseId?: string; createdFrom?: Date; createdTo?: Date };

  function filteredQuery(filters: AuditFilters) {
    const qb = app.dataSource.getRepository(AuditLog).createQueryBuilder('a');
    if (filters.actorId) qb.andWhere('a."actorId" = :actorId', { actorId: filters.actorId });
    if (filters.action) qb.andWhere('a.action = :action', { action: filters.action });
    if (filters.caseId) qb.andWhere('a."caseId" = :caseId', { caseId: filters.caseId });
    if (filters.createdFrom) qb.andWhere('a."createdAt" >= :createdFrom', { createdFrom: filters.createdFrom });
    if (filters.createdTo) qb.andWhere('a."createdAt" <= :createdTo', { createdTo: filters.createdTo });
    return qb;
  }

  typedApp.get('/audit', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { tags: ['Audit'], security: [{ bearerAuth: [] }], querystring: auditQuerySchema, response: { 200: auditListResponseSchema } },
  }, async (request) => {
    const query = request.query;
    const { skip, take } = paginationToSkipTake(query);
    const [rows, total] = await filteredQuery(query).orderBy('a."createdAt"', 'DESC').addOrderBy('a.id', 'DESC').skip(skip).take(take).getManyAndCount();
    return buildPaginatedResponse(await serializeAuditRows(app.dataSource, rows), total, query);
  });

  typedApp.get('/cases/:id/audit', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Audit'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      querystring: paginationQuerySchema
        .extend({ createdFrom: z.coerce.date().optional(), createdTo: z.coerce.date().optional() })
        .refine(dateOrder, dateOrderMessage),
      response: { 200: auditListResponseSchema },
    },
  }, async (request) =>
    listCaseAudit(app.dataSource, {
      id: request.user.id, role: request.user.role, departmentId: request.user.departmentId,
      entityId: request.user.entityId, businessUnitId: request.user.businessUnitId,
    }, request.params.id, request.query));

  const AUDIT_EXPORT_COLUMNS: CsvColumn<AuditRowResponse>[] = [
    { header: 'id', value: (row) => row.id },
    { header: 'caseId', value: (row) => row.caseId },
    { header: 'actorId', value: (row) => row.actorId },
    { header: 'action', value: (row) => row.action },
    { header: 'createdAt', value: (row) => row.createdAt },
    { header: 'beforeValue', value: (row) => row.beforeValue },
    { header: 'afterValue', value: (row) => row.afterValue },
    { header: 'actorName', value: (row) => row.actorName },
    { header: 'actorRole', value: (row) => row.actorRole },
    { header: 'caseReference', value: (row) => row.caseReference },
  ];

  typedApp.get('/audit/export', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { tags: ['Audit'], security: [{ bearerAuth: [] }], querystring: auditExportQuerySchema },
  }, async (request, reply) => {
    const cap = opts.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP;
    const total = await filteredQuery(request.query).getCount();
    const rows = await filteredQuery(request.query).orderBy('a."createdAt"', 'DESC').addOrderBy('a.id', 'DESC').take(cap).getMany();
    const serialized = await serializeAuditRows(app.dataSource, rows);
    return sendCsv(reply, 'audit', toCsv(serialized, AUDIT_EXPORT_COLUMNS), { total, truncated: total > rows.length });
  });
}
