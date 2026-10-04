import type { Case } from './entities/case.entity';

// BRD requires an "at-risk" state (AU-11/DR-08) but specifies no numeric
// rule. Percentage-of-window scales with each case type's own SLA length
// instead of one fixed hour count across very different SLA durations
// (brainstorming session decision, 2026-10-01).
export const SLA_AT_RISK_WINDOW_FRACTION = 0.2;

export function computeDueDates(
  submittedAt: Date,
  slaAckHours: number,
  slaResolutionHours: number,
): { ackDueAt: Date; resolutionDueAt: Date } {
  const HOUR_MS = 60 * 60 * 1000;
  return {
    ackDueAt: new Date(submittedAt.getTime() + slaAckHours * HOUR_MS),
    resolutionDueAt: new Date(submittedAt.getTime() + slaResolutionHours * HOUR_MS),
  };
}

export type SlaState = 'on_track' | 'at_risk' | 'breached' | 'met';

export function deriveSlaState(params: {
  createdAt: Date;
  resolutionDueAt: Date;
  status: string;
  closedAt: Date | null;
  now?: Date;
}): SlaState {
  const now = params.now ?? new Date();

  if (params.status === 'Closed') {
    return params.closedAt !== null && params.closedAt.getTime() <= params.resolutionDueAt.getTime() ? 'met' : 'breached';
  }
  if (now.getTime() > params.resolutionDueAt.getTime()) {
    return 'breached';
  }
  const windowMs = params.resolutionDueAt.getTime() - params.createdAt.getTime();
  const remainingMs = params.resolutionDueAt.getTime() - now.getTime();
  if (windowMs > 0 && remainingMs <= windowMs * SLA_AT_RISK_WINDOW_FRACTION) {
    return 'at_risk';
  }
  return 'on_track';
}

export function deriveCaseAgeHours(createdAt: Date, closedAt: Date | null, now: Date = new Date()): number {
  const end = closedAt ?? now;
  return (end.getTime() - createdAt.getTime()) / (60 * 60 * 1000);
}

export function toCaseWithSla<T extends Case>(caseRow: T, now: Date = new Date()): T & { slaState: SlaState; caseAgeHours: number } {
  return {
    ...caseRow,
    slaState: deriveSlaState({
      createdAt: caseRow.createdAt,
      resolutionDueAt: caseRow.resolutionDueAt,
      status: caseRow.status,
      closedAt: caseRow.closedAt,
      now,
    }),
    caseAgeHours: deriveCaseAgeHours(caseRow.createdAt, caseRow.closedAt, now),
  };
}
