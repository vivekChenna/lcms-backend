import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import type { Actor } from '../cases/cases.service';
import { DEFAULT_EXPORT_ROW_CAP, sendCsvRows, type CsvColumn } from './csv';
import { ageingReport, slaComplianceReport, type SlaComplianceRow } from './reports.service';
import { ageingResponseSchema, reportQuerySchema, slaComplianceResponseSchema } from './reports.schemas';

export const REPORT_ROLES = ['admin', 'legal_manager', 'viewer'];

const SLA_COLUMNS: CsvColumn<SlaComplianceRow>[] = [
  { header: 'closedOnTime', value: (row) => row.closedOnTime },
  { header: 'closedLate', value: (row) => row.closedLate },
  { header: 'openOnTrack', value: (row) => row.openOnTrack },
  { header: 'openAtRisk', value: (row) => row.openAtRisk },
  { header: 'openBreached', value: (row) => row.openBreached },
  { header: 'compliancePercent', value: (row) => row.compliancePercent },
];

const AGEING_COLUMNS: CsvColumn<{ bucket: string; count: number }>[] = [
  { header: 'bucket', value: (row) => row.bucket },
  { header: 'count', value: (row) => row.count },
];

export default async function reportsRoutes(app: FastifyInstance, opts: { exportRowCap?: number } = {}): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const cap = opts.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP;
  const guard = [app.authenticate, requireRole(REPORT_ROLES)];
  const meta = { tags: ['Reports'], security: [{ bearerAuth: [] }] };
  const actorOf = (user: { id: string; role: string; departmentId: string | null; entityId: string | null; businessUnitId: string | null }): Actor => ({
    id: user.id,
    role: user.role,
    departmentId: user.departmentId,
    entityId: user.entityId,
    businessUnitId: user.businessUnitId,
  });

  typedApp.get('/reports/sla-compliance', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema, response: { 200: slaComplianceResponseSchema } },
  }, async (request) => slaComplianceReport(app.dataSource, actorOf(request.user), request.query));

  typedApp.get('/reports/sla-compliance/export', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema },
  }, async (request, reply) => {
    const row = await slaComplianceReport(app.dataSource, actorOf(request.user), request.query);
    return sendCsvRows(reply, 'sla-compliance', [row], SLA_COLUMNS, cap);
  });

  typedApp.get('/reports/ageing', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema, response: { 200: ageingResponseSchema } },
  }, async (request) => ageingReport(app.dataSource, actorOf(request.user), request.query));

  typedApp.get('/reports/ageing/export', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema },
  }, async (request, reply) => {
    const rows = await ageingReport(app.dataSource, actorOf(request.user), request.query);
    return sendCsvRows(reply, 'ageing', rows, AGEING_COLUMNS, cap);
  });
}
