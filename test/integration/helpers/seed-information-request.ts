import type { DataSource } from 'typeorm';
import { InformationRequest } from '../../../src/modules/information-requests/entities/information-request.entity';

export async function seedInformationRequest(
  dataSource: DataSource,
  overrides: Partial<{
    caseId: string;
    subject: string;
    requirementDescription: string;
    raisedById: string;
    responderId: string;
    dueDate: Date | null;
    status: InformationRequest['status'];
    responseText: string | null;
    reopenedFromId: string | null;
  }> = {},
): Promise<InformationRequest> {
  function mustProvide(field: string): never {
    throw new Error(`seedInformationRequest: ${field} is required`);
  }
  const repo = dataSource.getRepository(InformationRequest);
  const row = repo.create({
    caseId: overrides.caseId ?? mustProvide('caseId'),
    subject: overrides.subject ?? 'Need clarification on scope',
    requirementDescription: overrides.requirementDescription ?? 'Please confirm the affected business unit.',
    raisedById: overrides.raisedById ?? mustProvide('raisedById'),
    responderId: overrides.responderId ?? mustProvide('responderId'),
    dueDate: overrides.dueDate ?? null,
    status: overrides.status ?? 'open',
    responseText: overrides.responseText ?? null,
    reopenedFromId: overrides.reopenedFromId ?? null,
  });
  return repo.save(row);
}
