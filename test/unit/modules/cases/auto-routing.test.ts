import { describe, it, expect } from 'vitest';
import { matchesCriteria } from '../../../../src/modules/cases/auto-routing';

const caseAttrs = {
  categoryId: 'cat-1',
  caseTypeId: 'type-1',
  entityId: 'entity-1',
  businessUnitId: 'bu-1',
  departmentId: 'dept-1',
  priority: 'P2',
};

describe('auto-routing matcher (pure)', () => {
  it('matches when every specified key equals the case value', () => {
    expect(matchesCriteria({ categoryId: 'cat-1', priority: 'P2' }, caseAttrs)).toBe(true);
  });

  it('does not match when a specified key differs', () => {
    expect(matchesCriteria({ categoryId: 'cat-2' }, caseAttrs)).toBe(false);
  });

  it('treats an absent key as a wildcard', () => {
    expect(matchesCriteria({}, caseAttrs)).toBe(true);
    expect(matchesCriteria({ businessUnitId: undefined }, caseAttrs)).toBe(true);
  });

  it('matches a null businessUnitId when the case has none', () => {
    expect(matchesCriteria({ businessUnitId: null }, { ...caseAttrs, businessUnitId: null })).toBe(true);
  });
});
