import type { DataSource } from 'typeorm';
import { CaseType } from './entities/case-type.entity';
import { CaseCategory } from './entities/case-category.entity';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

export async function listCaseTypes(dataSource: DataSource, categoryId?: string): Promise<CaseType[]> {
  const where = categoryId ? { categoryId } : {};
  return dataSource.getRepository(CaseType).find({ where, order: { name: 'ASC' } });
}

export type CreateCaseTypeInput = {
  categoryId: string;
  name: string;
  description?: string;
  slaAckHours: number;
  slaResolutionHours: number;
};

export async function createCaseType(
  dataSource: DataSource,
  actorId: string,
  input: CreateCaseTypeInput,
): Promise<CaseType> {
  const category = await dataSource.getRepository(CaseCategory).findOne({ where: { id: input.categoryId } });
  if (!category) {
    throw new ValidationError('Unknown categoryId');
  }

  const repo = dataSource.getRepository(CaseType);
  const existing = await repo.findOne({ where: { categoryId: input.categoryId, name: input.name } });
  if (existing) {
    throw new ConflictError(`Case type '${input.name}' already exists for this category`);
  }

  const caseType = await repo.save(
    repo.create({
      categoryId: input.categoryId,
      name: input.name,
      description: input.description ?? null,
      slaAckHours: input.slaAckHours,
      slaResolutionHours: input.slaResolutionHours,
      isActive: true,
    }),
  );
  await logAuditEvent(dataSource, { actorId, action: 'case_type.created', afterValue: caseType });
  return caseType;
}

export async function updateCaseType(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: Partial<Omit<CreateCaseTypeInput, 'categoryId'>> & { isActive?: boolean },
): Promise<CaseType> {
  const repo = dataSource.getRepository(CaseType);
  const caseType = await repo.findOne({ where: { id } });
  if (!caseType) {
    throw new NotFoundError('Case type not found');
  }
  const before = { ...caseType };
  if (input.name !== undefined) caseType.name = input.name;
  if (input.description !== undefined) caseType.description = input.description;
  if (input.slaAckHours !== undefined) caseType.slaAckHours = input.slaAckHours;
  if (input.slaResolutionHours !== undefined) caseType.slaResolutionHours = input.slaResolutionHours;
  if (input.isActive !== undefined) caseType.isActive = input.isActive;
  await repo.save(caseType);
  await logAuditEvent(dataSource, { actorId, action: 'case_type.updated', beforeValue: before, afterValue: caseType });
  return caseType;
}
