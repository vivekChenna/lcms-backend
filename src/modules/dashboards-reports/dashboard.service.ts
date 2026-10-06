import type { DataSource, SelectQueryBuilder } from 'typeorm';
import { Case, type CaseStatus } from '../cases/entities/case.entity';
import { User } from '../users/entities/user.entity';
import { applyCaseFilters, type Actor } from '../cases/cases.service';
import { toCaseWithSla } from '../cases/sla';
import { loadUserNames } from '../../shared/name-lookup';
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
  unassigned: { status: 'Submitted' },
};

// Requester and confidential scope come from applyCaseFilters (the same rule as GET /cases);
// every other role, including a legal rep, sees the whole organisation.
function scopedQuery(dataSource: DataSource, actor: Actor): SelectQueryBuilder<Case> {
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');
  applyCaseFilters(qb, actor, {});
  return qb;
}

async function toPanelItems(dataSource: DataSource, rows: Case[]) {
  const names = await loadUserNames(dataSource, rows.map((row) => row.assignedLegalRepId));
  return rows.map((row) => {
    const withSla = toCaseWithSla(row);
    return {
      id: withSla.id,
      referenceNumber: withSla.referenceNumber,
      title: withSla.title,
      priority: withSla.priority,
      status: withSla.status,
      resolutionDueAt: withSla.resolutionDueAt.toISOString(),
      slaState: withSla.slaState,
      assignedLegalRepName: (row.assignedLegalRepId ? names.get(row.assignedLegalRepId)?.fullName : null) ?? null,
    };
  });
}

async function panel(dataSource: DataSource, actor: Actor, status: CaseStatus) {
  const base = () => scopedQuery(dataSource, actor).andWhere('c."status" = :panelStatus', { panelStatus: status });
  const count = await base().getCount();
  const rows = await base().orderBy('c."createdAt"', 'ASC').addOrderBy('c."id"', 'ASC').limit(PANEL_LIMIT).getMany();
  return { count, items: await toPanelItems(dataSource, rows) };
}

async function assignedOpenPanel(dataSource: DataSource, actor: Actor) {
  const rows = await scopedQuery(dataSource, actor)
    .andWhere('c."assignedLegalRepId" = :me', { me: actor.id })
    .andWhere(`c."status" != 'Closed'`)
    .orderBy('c."createdAt"', 'ASC')
    .addOrderBy('c."id"', 'ASC')
    .limit(PANEL_LIMIT)
    .getMany();
  return toPanelItems(dataSource, rows);
}

export async function getDashboard(dataSource: DataSource, actor: Actor): Promise<DashboardResult> {
  const tileRow = await scopedQuery(dataSource, actor)
    .select('COUNT(*)', 'total')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed')`, 'open')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Assigned')`, 'awaitingAcceptance')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Waiting on Input')`, 'waitingOnInput')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."resolutionDueAt" < now())`, 'overdue')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Closed')`, 'closed')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."assignedLegalRepId" = :tileActorId)`, 'assignedToMe')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Submitted')`, 'unassigned')
    .setParameter('tileActorId', actor.id)
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
      assignedToMe: Number(tileRow?.assignedToMe ?? 0),
      unassigned: Number(tileRow?.unassigned ?? 0),
    },
    filters: { ...TILE_FILTERS, assignedToMe: { open: 'true', assignedLegalRepId: actor.id } },
    byStatus,
  };

  if (actor.role === 'legal_rep') {
    result.myAssignedCases = await assignedOpenPanel(dataSource, actor);
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
