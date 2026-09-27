import { describe, it, expect } from 'vitest';
import { requireRole } from '../../../src/shared/rbac';
import { ForbiddenError } from '../../../src/shared/errors';

function fakeRequest(role: string) {
  return { user: { id: 'u1', role, departmentId: null, entityId: null, businessUnitId: null } } as any;
}

describe('requireRole', () => {
  it('allows a request whose role is in the allow-list', () => {
    const handler = requireRole(['admin', 'legal_manager']);
    expect(() => handler(fakeRequest('admin'), {} as any)).not.toThrow();
  });

  it('throws ForbiddenError for a role not in the allow-list', () => {
    const handler = requireRole(['admin']);
    expect(() => handler(fakeRequest('requester'), {} as any)).toThrow(ForbiddenError);
  });
});
