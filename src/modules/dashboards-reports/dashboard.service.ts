import type { DataSource, SelectQueryBuilder } from 'typeorm';
import { Case, type CaseStatus } from '../cases/entities/case.entity';
import { User } from '../users/entities/user.entity';
import { applyCaseFilters, type Actor } from '../cases/cases.service';
import { toCaseWithSla } from '../cases/sla';
import type { DashboardResult } from './dashboard.schemas';

const STATUSES: CaseStatus[] = ['Submitted', 'Assigned', 'In Progress', 'Waiting on Input', 'Closed'];
const PANEL_LIMIT = 20;

const TILE_FILTERS: DashboardResult['filters'] = {
  total: {},
  open: { open: 'true' },
  awaitingAcceptance: { status: 'Assigned' },
  waitingOnInput: { status: 'Waiting on Input' },
  overdue: { open: 'true', slaState: 'breached' },
  closed: { status: 'Closed' },
};

// GET /cases does not limit a legal rep to their own cases, so a rep's tile filters
// must carry the assignee to reproduce the rep's counts (UI-10/11).
function tileFiltersFor(actor: Actor): DashboardResult['filters'] {
  if (actor.role !== 'legal_rep') {
    return TILE_FILTERS;
  }
  return Object.fromEntries(
    Object.entries(TILE_FILTERS).map(([tile, filter]) => [tile, { ...filter, assignedLegalRepId: actor.id }]),
  );
}

// Requester scope comes from applyCaseFilters (the same rule as GET /cases);
// a legal rep is limited to their own cases; manager/admin/viewer see all.
function scopedQuery(dataSource: DataSource, actor: Actor): SelectQueryBuilder<Case> {
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');
  applyCaseFilters(qb, actor, {});
  if (actor.role === 'legal_rep') {
    qb.andWhere('c."assignedLegalRepId" = :repScopeId', { repScopeId: actor.id });
  }
  return qb;
}

async function panel(dataSource: DataSource, actor: Actor, status: CaseStatus, onlyAssignedToActor = false) {
  const base = () => {
    const qb = scopedQuery(dataSource, actor).andWhere('c."status" = :panelStatus', { panelStatus: status });
    if (onlyAssignedToActor) {
      qb.andWhere('c."assignedLegalRepId" = :panelActorId', { panelActorId: actor.id });
    }
    return qb;
  };
  const count = await base().getCount();
  const rows = await base().orderBy('c."createdAt"', 'ASC').addOrderBy('c."id"', 'ASC').limit(PANEL_LIMIT).getMany();
  const items = rows.map((row) => {
    const withSla = toCaseWithSla(row);
    return {
      id: withSla.id,
      referenceNumber: withSla.referenceNumber,
      title: withSla.title,
      priority: withSla.priority,
      status: withSla.status,
      resolutionDueAt: withSla.resolutionDueAt.toISOString(),
      slaState: withSla.slaState,
    };
  });
  return { count, items };
}

export async function getDashboard(dataSource: DataSource, actor: Actor): Promise<DashboardResult> {
  const tileRow = await scopedQuery(dataSource, actor)
    .select('COUNT(*)', 'total')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed')`, 'open')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Assigned')`, 'awaitingAcceptance')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Waiting on Input')`, 'waitingOnInput')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."resolutionDueAt" < now())`, 'overdue')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Closed')`, 'closed')
    .getRawOne<Record<string, string>>();
  const total = Number(tileRow?.total ?? 0);
  const overdue = Number(tileRow?.overdue ?? 0);

  const statusRows = await scopedQuery(dataSource, actor)
    .select('c."status"', 'status')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c."status"')
    .getRawMany<{ status: CaseStatus; count: string }>();
  const byStatus = STATUSES.map((status) => ({
    status,
    count: Number(statusRows.find((row) => row.status === status)?.count ?? 0),
  }));

  const result: DashboardResult = {
    tiles: {
      total,
      open: Number(tileRow?.open ?? 0),
      awaitingAcceptance: Number(tileRow?.awaitingAcceptance ?? 0),
      waitingOnInput: Number(tileRow?.waitingOnInput ?? 0),
      overdue,
      onTime: total - overdue,
      closed: Number(tileRow?.closed ?? 0),
    },
    filters: tileFiltersFor(actor),
    byStatus,
  };

  if (actor.role === 'legal_rep') {
    result.myAssignedCases = (await panel(dataSource, actor, 'Assigned', true)).items;
  }

  if (actor.role === 'legal_manager' || actor.role === 'admin') {
    const loadRows = await scopedQuery(dataSource, actor)
      .innerJoin(User, 'u', 'u.id = c."assignedLegalRepId"')
      .select('c."assignedLegalRepId"', 'legalRepId')
      .addSelect('u."fullName"', 'fullName')
      .addSelect('COUNT(*)', 'openCount')
      .addSelect('COUNT(*) FILTER (WHERE c."resolutionDueAt" < now())', 'overdueCount')
      .andWhere(`c."status" != 'Closed'`)
      .groupBy('c."assignedLegalRepId"')
      .addGroupBy('u."fullName"')
      .orderBy('COUNT(*)', 'DESC')
      .addOrderBy('u."fullName"', 'ASC')
      .addOrderBy('c."assignedLegalRepId"', 'ASC')
      .getRawMany<{ legalRepId: string; fullName: string; openCount: string; overdueCount: string }>();
    result.managerPanels = {
      openCaseloadByRep: loadRows.map((row) => ({
        legalRepId: row.legalRepId,
        fullName: row.fullName,
        openCount: Number(row.openCount),
        overdueCount: Number(row.overdueCount),
      })),
      unassigned: await panel(dataSource, actor, 'Submitted'),
      awaitingAcceptance: await panel(dataSource, actor, 'Assigned'),
    };
  }

  return result;
}
