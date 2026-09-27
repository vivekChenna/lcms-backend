import { describe, it, expect } from 'vitest';
import { paginationQuerySchema, paginationToSkipTake, buildPaginatedResponse } from '../../../src/shared/pagination';

describe('pagination helpers', () => {
  it('defaults to page 1, pageSize 20', () => {
    const parsed = paginationQuerySchema.parse({});
    expect(parsed).toEqual({ page: 1, pageSize: 20 });
  });

  it('converts page/pageSize into skip/take', () => {
    expect(paginationToSkipTake({ page: 3, pageSize: 10 })).toEqual({ skip: 20, take: 10 });
  });

  it('builds a paginated response envelope', () => {
    const result = buildPaginatedResponse(['a', 'b'], 42, { page: 2, pageSize: 2 });
    expect(result).toEqual({ items: ['a', 'b'], total: 42, page: 2, pageSize: 2 });
  });

  it('rejects a pageSize above 100', () => {
    expect(() => paginationQuerySchema.parse({ pageSize: 500 })).toThrow();
  });
});
