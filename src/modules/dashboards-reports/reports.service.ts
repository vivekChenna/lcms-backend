import type { DataSource, SelectQueryBuilder } from 'typeorm';
import { Case } from '../cases/entities/case.entity';
import { applyCaseFilters, SLA_STATE_CONDITIONS, type Actor } from '../cases/cases.service';
import type { ReportQuery } from './reports.schemas';
import { CaseCategory } from '../master-data/entities/case-category.entity';
import { CaseType } from '../master-data/entities/case-type.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';
import { Department } from '../master-data/entities/department.entity';
import { User } from '../users/entities/user.entity';

export type SlaComplianceRow = {
  closedOnTime: number;
  closedLate: number;
  openOnTrack: number;
  openAtRisk: number;
  openBreached: number;
  compliancePercent: number | null;
};

export type AgeingBucket = '0-7' | '8-30' | '31-90' | '91+';

// Reports are role-gated to admin / legal manager / viewer, so the actor never
// triggers the requester scope; it is passed through so the one shared filter
// function stays the only place scope is decided.
export function reportBaseQuery(dataSource: DataSource, actor: Actor, filters: ReportQuery): SelectQueryBuilder<Case> {
  const { createdFrom, createdTo, ...caseFilters } = filters;
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');
  applyCaseFilters(qb, actor, caseFilters);
  if (createdFrom) {
    qb.andWhere('c."createdAt" >= :createdFrom', { createdFrom });
  }
  if (createdTo) {
    qb.andWhere('c."createdAt" <= :createdTo', { createdTo });
  }
  return qb;
}

export async function slaComplianceReport(dataSource: DataSource, actor: Actor, filters: ReportQuery): Promise<SlaComplianceRow> {
  const row = await reportBaseQuery(dataSource, actor, filters)
    .select(`COUNT(*) FILTER (WHERE ${SLA_STATE_CONDITIONS.met})`, 'closedOnTime')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Closed' AND c."closedAt" > c."resolutionDueAt")`, 'closedLate')
    .addSelect(`COUNT(*) FILTER (WHERE ${SLA_STATE_CONDITIONS.on_track})`, 'openOnTrack')
    .addSelect(`COUNT(*) FILTER (WHERE ${SLA_STATE_CONDITIONS.at_risk})`, 'openAtRisk')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."resolutionDueAt" < now())`, 'openBreached')
    .getRawOne<Record<string, string>>();
  const closedOnTime = Number(row?.closedOnTime ?? 0);
  const closedLate = Number(row?.closedLate ?? 0);
  const closed = closedOnTime + closedLate;
  return {
    closedOnTime,
    closedLate,
    openOnTrack: Number(row?.openOnTrack ?? 0),
    openAtRisk: Number(row?.openAtRisk ?? 0),
    openBreached: Number(row?.openBreached ?? 0),
    compliancePercent: closed === 0 ? null : Math.round((closedOnTime / closed) * 1000) / 10,
  };
}

export async function ageingReport(
  dataSource: DataSource,
  actor: Actor,
  filters: ReportQuery,
): Promise<{ bucket: AgeingBucket; count: number }[]> {
  const row = await reportBaseQuery(dataSource, actor, filters)
    .select(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" > now() - interval '8 days')`, 'b0')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" <= now() - interval '8 days' AND c."createdAt" > now() - interval '31 days')`, 'b1')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" <= now() - interval '31 days' AND c."createdAt" > now() - interval '91 days')`, 'b2')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" <= now() - interval '91 days')`, 'b3')
    .getRawOne<Record<string, string>>();
  return [
    { bucket: '0-7', count: Number(row?.b0 ?? 0) },
    { bucket: '8-30', count: Number(row?.b1 ?? 0) },
    { bucket: '31-90', count: Number(row?.b2 ?? 0) },
    { bucket: '91+', count: Number(row?.b3 ?? 0) },
  ];
}

export async function volumeByCategoryReport(dataSource: DataSource, actor: Actor, filters: ReportQuery) {
  const rows = await reportBaseQuery(dataSource, actor, filters)
    .innerJoin(CaseCategory, 'cat', 'cat.id = c."categoryId"')
    .innerJoin(CaseType, 'ct', 'ct.id = c."caseTypeId"')
    .select('c."categoryId"', 'categoryId')
    .addSelect('cat.name', 'categoryName')
    .addSelect('c."caseTypeId"', 'caseTypeId')
    .addSelect('ct.name', 'caseTypeName')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c."categoryId"')
    .addGroupBy('cat.name')
    .addGroupBy('c."caseTypeId"')
    .addGroupBy('ct.name')
    .orderBy('COUNT(*)', 'DESC')
    .addOrderBy('cat.name', 'ASC')
    .addOrderBy('ct.name', 'ASC')
    .addOrderBy('c."caseTypeId"', 'ASC')
    .getRawMany<{ categoryId: string; categoryName: string; caseTypeId: string; caseTypeName: string; count: string }>();
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}

export async function volumeByOrganisationReport(dataSource: DataSource, actor: Actor, filters: ReportQuery) {
  const rows = await reportBaseQuery(dataSource, actor, filters)
    .innerJoin(OrgEntity, 'en', 'en.id = c."entityId"')
    .leftJoin(BusinessUnit, 'bu', 'bu.id = c."businessUnitId"')
    .innerJoin(Department, 'dep', 'dep.id = c."departmentId"')
    .select('c."entityId"', 'entityId')
    .addSelect('en.name', 'entityName')
    .addSelect('c."businessUnitId"', 'businessUnitId')
    .addSelect('bu.name', 'businessUnitName')
    .addSelect('c."departmentId"', 'departmentId')
    .addSelect('dep.name', 'departmentName')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c."entityId"')
    .addGroupBy('en.name')
    .addGroupBy('c."businessUnitId"')
    .addGroupBy('bu.name')
    .addGroupBy('c."departmentId"')
    .addGroupBy('dep.name')
    .orderBy('COUNT(*)', 'DESC')
    .addOrderBy('en.name', 'ASC')
    .addOrderBy('dep.name', 'ASC')
    .addOrderBy('c."businessUnitId"', 'ASC')
    .getRawMany<{
      entityId: string; entityName: string; businessUnitId: string | null; businessUnitName: string | null;
      departmentId: string; departmentName: string; count: string;
    }>();
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}

export async function repWorkloadReport(dataSource: DataSource, actor: Actor, filters: ReportQuery) {
  const rows = await reportBaseQuery(dataSource, actor, filters)
    .innerJoin(User, 'u', 'u.id = c."assignedLegalRepId"')
    .andWhere(`c."status" != 'Closed'`)
    .select('c."assignedLegalRepId"', 'legalRepId')
    .addSelect('u."fullName"', 'fullName')
    .addSelect('COUNT(*)', 'openCount')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Assigned')`, 'awaitingAcceptanceCount')
    .addSelect('COUNT(*) FILTER (WHERE c."resolutionDueAt" < now())', 'overdueCount')
    .groupBy('c."assignedLegalRepId"')
    .addGroupBy('u."fullName"')
    .orderBy('COUNT(*)', 'DESC')
    .addOrderBy('u."fullName"', 'ASC')
    .addOrderBy('c."assignedLegalRepId"', 'ASC')
    .getRawMany<{ legalRepId: string; fullName: string; openCount: string; awaitingAcceptanceCount: string; overdueCount: string }>();
  return rows.map((row) => ({
    legalRepId: row.legalRepId,
    fullName: row.fullName,
    openCount: Number(row.openCount),
    awaitingAcceptanceCount: Number(row.awaitingAcceptanceCount),
    overdueCount: Number(row.overdueCount),
  }));
}
