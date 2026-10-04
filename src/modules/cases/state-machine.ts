import { ConflictError } from '../../shared/errors';
import type { CaseStatus } from './entities/case.entity';

// Reassignment (PR-23) can happen from Assigned, In Progress, or Waiting on
// Input back to Assigned — a legal_manager can override at any point except
// once the case is Closed. The In Progress <-> Waiting on Input edges are
// driven by the information-requests module (via markCaseWaitingOnInput /
// markCaseInProgress in cases.workflow.service.ts).
const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  Submitted: ['Assigned'],
  Assigned: ['In Progress', 'Submitted', 'Assigned'],
  'In Progress': ['Waiting on Input', 'Closed', 'Assigned'],
  'Waiting on Input': ['In Progress', 'Assigned'],
  Closed: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`Cannot transition case from '${from}' to '${to}'`);
  }
}
