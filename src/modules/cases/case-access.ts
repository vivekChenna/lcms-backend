import { ConflictError, ForbiddenError } from '../../shared/errors';
import type { Actor } from './cases.service';

const LEGAL_ROLES = ['legal_rep', 'legal_manager', 'admin'];

export function isLegalRole(role: string): boolean {
  return LEGAL_ROLES.includes(role);
}

export function assertCaseNotClosed(caseRow: { status: string }): void {
  if (caseRow.status === 'Closed') {
    throw new ConflictError('Closed cases are read-only');
  }
}

// Write eligibility for documents and comments, applied AFTER the visibility
// gate (getCaseById) has already passed. Order matters: role before state
// (a viewer can never write), state before ownership (a Closed case must report
// 409 even to a legal_rep who is not its owner), per case core's check-ordering
// lesson in decisions/case-core/task-12-closure.md.
export function assertCaseWriteEligibility(
  actor: Actor,
  caseRow: { status: string; assignedLegalRepId: string | null },
): void {
  if (actor.role === 'viewer') {
    throw new ForbiddenError('Viewers cannot add or change documents or comments');
  }
  assertCaseNotClosed(caseRow);
  if (actor.role === 'legal_rep') {
    const acceptedByActor =
      caseRow.assignedLegalRepId === actor.id && (caseRow.status === 'In Progress' || caseRow.status === 'Waiting on Input');
    if (!acceptedByActor) {
      throw new ForbiddenError('Only the assigned legal representative who accepted the case can write to it');
    }
  }
}
