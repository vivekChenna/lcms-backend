import { describe, it, expect } from 'vitest';
import { computeDueDates, deriveSlaState, deriveCaseAgeHours, toCaseWithSla } from '../../../../src/modules/cases/sla';
import type { Case } from '../../../../src/modules/cases/entities/case.entity';

describe('SLA helpers', () => {
  it('computes ack and resolution due dates from submission time', () => {
    const submittedAt = new Date('2026-01-01T00:00:00Z');
    const { ackDueAt, resolutionDueAt } = computeDueDates(submittedAt, 4, 72);
    expect(ackDueAt.toISOString()).toBe('2026-01-01T04:00:00.000Z');
    expect(resolutionDueAt.toISOString()).toBe('2026-01-04T00:00:00.000Z');
  });

  it('is on_track well before the due date', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const resolutionDueAt = new Date('2026-01-11T00:00:00Z'); // 10-day window
    const now = new Date('2026-01-02T00:00:00Z'); // 90% remaining
    expect(deriveSlaState({ createdAt, resolutionDueAt, status: 'In Progress', closedAt: null, now })).toBe('on_track');
  });

  it('is at_risk with less than 20% of the window remaining', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const resolutionDueAt = new Date('2026-01-11T00:00:00Z'); // 10-day window
    const now = new Date('2026-01-10T00:00:00Z'); // 1 day (10%) remaining
    expect(deriveSlaState({ createdAt, resolutionDueAt, status: 'In Progress', closedAt: null, now })).toBe('at_risk');
  });

  it('is breached when open and past the resolution due date', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const resolutionDueAt = new Date('2026-01-11T00:00:00Z');
    const now = new Date('2026-01-12T00:00:00Z');
    expect(deriveSlaState({ createdAt, resolutionDueAt, status: 'In Progress', closedAt: null, now })).toBe('breached');
  });

  it('is met when closed before the resolution due date', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const resolutionDueAt = new Date('2026-01-11T00:00:00Z');
    const closedAt = new Date('2026-01-05T00:00:00Z');
    expect(deriveSlaState({ createdAt, resolutionDueAt, status: 'Closed', closedAt })).toBe('met');
  });

  it('is breached when closed after the resolution due date', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const resolutionDueAt = new Date('2026-01-11T00:00:00Z');
    const closedAt = new Date('2026-01-12T00:00:00Z');
    expect(deriveSlaState({ createdAt, resolutionDueAt, status: 'Closed', closedAt })).toBe('breached');
  });

  it('computes case age in hours for an open case', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-02T00:00:00Z');
    expect(deriveCaseAgeHours(createdAt, null, now)).toBe(24);
  });

  it('computes case age in hours frozen at closedAt for a closed case', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const closedAt = new Date('2026-01-02T00:00:00Z');
    const now = new Date('2026-01-10T00:00:00Z');
    expect(deriveCaseAgeHours(createdAt, closedAt, now)).toBe(24);
  });

  it('attaches slaState and caseAgeHours to a case row', () => {
    const caseRow = {
      createdAt: new Date('2026-01-01T00:00:00Z'),
      resolutionDueAt: new Date('2026-01-11T00:00:00Z'),
      status: 'In Progress',
      closedAt: null,
    } as Case;
    const now = new Date('2026-01-02T00:00:00Z');
    const result = toCaseWithSla(caseRow, now);
    expect(result.slaState).toBe('on_track');
    expect(result.caseAgeHours).toBe(24);
  });
});
