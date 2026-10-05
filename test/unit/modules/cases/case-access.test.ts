import { describe, it, expect } from 'vitest';
import { assertCaseNotClosed, assertCaseWriteEligibility, isLegalRole } from '../../../../src/modules/cases/case-access';
import { ConflictError, ForbiddenError } from '../../../../src/shared/errors';

const actor = (role: string, id = 'u1') => ({ id, role, departmentId: null, entityId: null, businessUnitId: null });
const caseRow = (status: string, assignedLegalRepId: string | null = 'u1') => ({ status, assignedLegalRepId });

describe('isLegalRole', () => {
  it('is true for legal_rep, legal_manager and admin only', () => {
    expect(isLegalRole('legal_rep')).toBe(true);
    expect(isLegalRole('legal_manager')).toBe(true);
    expect(isLegalRole('admin')).toBe(true);
    expect(isLegalRole('requester')).toBe(false);
    expect(isLegalRole('viewer')).toBe(false);
  });
});

describe('assertCaseNotClosed', () => {
  it('throws ConflictError only for a Closed case', () => {
    expect(() => assertCaseNotClosed({ status: 'Closed' })).toThrow(ConflictError);
    expect(() => assertCaseNotClosed({ status: 'In Progress' })).not.toThrow();
  });
});

describe('assertCaseWriteEligibility', () => {
  it('rejects a viewer with 403, even on a Closed case (role before state)', () => {
    expect(() => assertCaseWriteEligibility(actor('viewer'), caseRow('In Progress'))).toThrow(ForbiddenError);
    expect(() => assertCaseWriteEligibility(actor('viewer'), caseRow('Closed'))).toThrow(ForbiddenError);
  });

  it('rejects any writer on a Closed case with 409, before the ownership check', () => {
    expect(() => assertCaseWriteEligibility(actor('admin'), caseRow('Closed'))).toThrow(ConflictError);
    expect(() => assertCaseWriteEligibility(actor('legal_rep', 'other'), caseRow('Closed'))).toThrow(ConflictError);
  });

  it('lets the assigned legal_rep write while In Progress or Waiting on Input', () => {
    expect(() => assertCaseWriteEligibility(actor('legal_rep'), caseRow('In Progress'))).not.toThrow();
    expect(() => assertCaseWriteEligibility(actor('legal_rep'), caseRow('Waiting on Input'))).not.toThrow();
  });

  it('rejects a legal_rep who is assigned but has not accepted (status Assigned)', () => {
    expect(() => assertCaseWriteEligibility(actor('legal_rep'), caseRow('Assigned'))).toThrow(ForbiddenError);
  });

  it('rejects a legal_rep who is not the assigned rep', () => {
    expect(() => assertCaseWriteEligibility(actor('legal_rep', 'other'), caseRow('In Progress'))).toThrow(ForbiddenError);
  });

  it('lets legal_manager, admin and requester write to an open case in any status', () => {
    for (const role of ['legal_manager', 'admin', 'requester']) {
      for (const status of ['Submitted', 'Assigned', 'In Progress', 'Waiting on Input']) {
        expect(() => assertCaseWriteEligibility(actor(role), caseRow(status, null))).not.toThrow();
      }
    }
  });
});
