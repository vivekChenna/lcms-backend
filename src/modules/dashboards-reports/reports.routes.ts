import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import type { Actor } from '../cases/cases.service';
import { DEFAULT_EXPORT_ROW_CAP, sendCsvRows, type CsvColumn } from './csv';
import {
  ageingReport,
  repWorkloadReport,
  slaComplianceReport,
  volumeByCategoryReport,
  volumeByOrganisationReport,
  type SlaComplianceRow,
} from './reports.service';
import {
  ageingResponseSchema,
  repWorkloadResponseSchema,
  reportQuerySchema,
  slaComplianceResponseSchema,
  volumeByCategoryResponseSchema,
  volumeByOrganisationResponseSchema,
} from './reports.schemas';

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

type VolumeCategoryRow = Awaited<ReturnType<typeof volumeByCategoryReport>>[number];
const VOLUMECATEGORY_COLUMNS: CsvColumn<VolumeCategoryRow>[] = [
  { header: 'categoryId', value: (row) => row.categoryId },
  { header: 'categoryName', value: (row) => row.categoryName },
  { header: 'caseTypeId', value: (row) => row.caseTypeId },
  { header: 'caseTypeName', value: (row) => row.caseTypeName },
  { header: 'count', value: (row) => row.count },
];

type VolumeOrganisationRow = Awaited<ReturnType<typeof volumeByOrganisationReport>>[number];
const VOLUMEORGANISATION_COLUMNS: CsvColumn<VolumeOrganisationRow>[] = [
  { header: 'entityId', value: (row) => row.entityId },
  { header: 'entityName', value: (row) => row.entityName },
  { header: 'businessUnitId', value: (row) => row.businessUnitId },
  { header: 'businessUnitName', value: (row) => row.businessUnitName },
  { header: 'departmentId', value: (row) => row.departmentId },
  { header: 'departmentName', value: (row) => row.departmentName },
  { header: 'count', value: (row) => row.count },
];

type RepWorkloadRow = Awaited<ReturnType<typeof repWorkloadReport>>[number];
const REPWORKLOAD_COLUMNS: CsvColumn<RepWorkloadRow>[] = [
  { header: 'legalRepId', value: (row) => row.legalRepId },
  { header: 'fullName', value: (row) => row.fullName },
  { header: 'openCount', value: (row) => row.openCount },
  { header: 'awaitingAcceptanceCount', value: (row) => row.awaitingAcceptanceCount },
  { header: 'overdueCount', value: (row) => row.overdueCount },
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

  typedApp.get('/reports/volume-by-category', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema, response: { 200: volumeByCategoryResponseSchema } },
  }, async (request) => volumeByCategoryReport(app.dataSource, actorOf(request.user), request.query));

  typedApp.get('/reports/volume-by-category/export', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema },
  }, async (request, reply) => {
    const rows = await volumeByCategoryReport(app.dataSource, actorOf(request.user), request.query);
    return sendCsvRows(reply, 'volume-by-category', rows, VOLUMECATEGORY_COLUMNS, cap);
  });

  typedApp.get('/reports/volume-by-organisation', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema, response: { 200: volumeByOrganisationResponseSchema } },
  }, async (request) => volumeByOrganisationReport(app.dataSource, actorOf(request.user), request.query));

  typedApp.get('/reports/volume-by-organisation/export', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema },
  }, async (request, reply) => {
    const rows = await volumeByOrganisationReport(app.dataSource, actorOf(request.user), request.query);
    return sendCsvRows(reply, 'volume-by-organisation', rows, VOLUMEORGANISATION_COLUMNS, cap);
  });

  typedApp.get('/reports/rep-workload', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema, response: { 200: repWorkloadResponseSchema } },
  }, async (request) => repWorkloadReport(app.dataSource, actorOf(request.user), request.query));

  typedApp.get('/reports/rep-workload/export', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema },
  }, async (request, reply) => {
    const rows = await repWorkloadReport(app.dataSource, actorOf(request.user), request.query);
    return sendCsvRows(reply, 'rep-workload', rows, REPWORKLOAD_COLUMNS, cap);
  });
}
