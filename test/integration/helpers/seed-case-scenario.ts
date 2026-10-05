import type { DataSource } from 'typeorm';
import type { Case } from '../../../src/modules/cases/entities/case.entity';
import { seedCase, seedCaseMasterData } from './seed-case';
import { seedUserWithRole } from './seed-user';

// A case with a legal_rep and a same-department requester. "In Progress",
// "Waiting on Input" and "Closed" cases are assigned to and accepted by the rep;
// "Assigned" is assigned but not accepted; "Submitted" is unassigned.
export async function seedCaseWithParties(
  ds: DataSource,
  overrides: { status?: Case['status'] } = {},
): Promise<{
  master: Awaited<ReturnType<typeof seedCaseMasterData>>;
  repId: string;
  requesterId: string;
  caseRow: Case;
}> {
  const status = overrides.status ?? 'In Progress';
  const master = await seedCaseMasterData(ds);
  const repId = await seedUserWithRole(ds, 'legal_rep');
  const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
  const accepted = status === 'In Progress' || status === 'Waiting on Input' || status === 'Closed';
  const caseRow = await seedCase(ds, {
    ...master,
    requesterId,
    status,
    assignedLegalRepId: status === 'Submitted' ? null : repId,
    assignmentAcceptedAt: accepted ? new Date() : null,
  });
  return { master, repId, requesterId, caseRow };
}
