import { describe, it, expect } from 'vitest';
import {
  createCaseBodySchema,
  escalateCaseBodySchema,
  closeCaseBodySchema,
  caseListQuerySchema,
} from '../../../../src/modules/cases/cases.schemas';

describe('case schemas', () => {
  it('accepts a valid case submission body', () => {
    const result = createCaseBodySchema.safeParse({
      title: 'Contract dispute',
      description: 'A description that is at least twenty characters long.',
      declarationConfirmed: true,
      categoryId: '11111111-1111-4111-8111-111111111111',
      caseTypeId: '22222222-2222-4222-8222-222222222222',
      departmentId: '33333333-3333-4333-8333-333333333333',
      entityId: '44444444-4444-4444-8444-444444444444',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a description shorter than 20 characters (VC-02)', () => {
    const result = createCaseBodySchema.safeParse({
      title: 'x',
      description: 'too short',
      declarationConfirmed: true,
      categoryId: '11111111-1111-4111-8111-111111111111',
      caseTypeId: '22222222-2222-4222-8222-222222222222',
      departmentId: '33333333-3333-4333-8333-333333333333',
      entityId: '44444444-4444-4444-8444-444444444444',
    });
    expect(result.success).toBe(false);
  });

  it('rejects declarationConfirmed: false (VC-01)', () => {
    const result = createCaseBodySchema.safeParse({
      title: 'x',
      description: 'A description that is at least twenty characters long.',
      declarationConfirmed: false,
      categoryId: '11111111-1111-4111-8111-111111111111',
      caseTypeId: '22222222-2222-4222-8222-222222222222',
      departmentId: '33333333-3333-4333-8333-333333333333',
      entityId: '44444444-4444-4444-8444-444444444444',
    });
    expect(result.success).toBe(false);
  });

  it('defaults priority to P3', () => {
    const result = createCaseBodySchema.parse({
      title: 'x',
      description: 'A description that is at least twenty characters long.',
      declarationConfirmed: true,
      categoryId: '11111111-1111-4111-8111-111111111111',
      caseTypeId: '22222222-2222-4222-8222-222222222222',
      departmentId: '33333333-3333-4333-8333-333333333333',
      entityId: '44444444-4444-4444-8444-444444444444',
    });
    expect(result.priority).toBe('P3');
  });

  it('requires a reason when escalating', () => {
    expect(escalateCaseBodySchema.safeParse({ isEscalated: true }).success).toBe(false);
    expect(escalateCaseBodySchema.safeParse({ isEscalated: true, reason: 'Client deadline' }).success).toBe(true);
    expect(escalateCaseBodySchema.safeParse({ isEscalated: false }).success).toBe(true);
  });

  it('requires confirm: true to close a case (VC-13)', () => {
    expect(
      closeCaseBodySchema.safeParse({
        confirm: false,
        closureSummary: 'Resolved via settlement.',
        closureOutcomeId: '55555555-5555-4555-8555-555555555555',
      }).success,
    ).toBe(false);
    expect(
      closeCaseBodySchema.safeParse({
        confirm: true,
        closureSummary: 'Resolved via settlement.',
        closureOutcomeId: '55555555-5555-4555-8555-555555555555',
      }).success,
    ).toBe(true);
  });

  it('defaults list pagination and accepts filters', () => {
    const result = caseListQuerySchema.parse({ status: 'Assigned', slaState: 'at_risk' });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.status).toBe('Assigned');
    expect(result.slaState).toBe('at_risk');
  });
});
