import type { DataSource } from 'typeorm';
import { OrgEntity } from './entities/org-entity.entity';
import { BusinessUnit } from './entities/business-unit.entity';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

export async function listEntities(dataSource: DataSource): Promise<OrgEntity[]> {
  return dataSource.getRepository(OrgEntity).find({ order: { name: 'ASC' } });
}

export async function createEntity(
  dataSource: DataSource,
  actorId: string,
  input: { name: string; code: string },
): Promise<OrgEntity> {
  const repo = dataSource.getRepository(OrgEntity);
  const existing = await repo.findOne({ where: [{ name: input.name }, { code: input.code }] });
  if (existing) {
    throw new ConflictError('An entity with this name or code already exists');
  }
  const entity = await repo.save(repo.create({ name: input.name, code: input.code, isActive: true }));
  await logAuditEvent(dataSource, { actorId, action: 'entity.created', afterValue: entity });
  return entity;
}

export async function updateEntity(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: { name?: string; code?: string; isActive?: boolean },
): Promise<OrgEntity> {
  const repo = dataSource.getRepository(OrgEntity);
  const entity = await repo.findOne({ where: { id } });
  if (!entity) {
    throw new NotFoundError('Entity not found');
  }
  const before = { name: entity.name, code: entity.code, isActive: entity.isActive };
  if (input.name !== undefined) entity.name = input.name;
  if (input.code !== undefined) entity.code = input.code;
  if (input.isActive !== undefined) entity.isActive = input.isActive;
  await repo.save(entity);
  await logAuditEvent(dataSource, {
    actorId,
    action: 'entity.updated',
    beforeValue: before,
    afterValue: { name: entity.name, code: entity.code, isActive: entity.isActive },
  });
  return entity;
}

export async function listBusinessUnits(dataSource: DataSource, entityId?: string): Promise<BusinessUnit[]> {
  const where = entityId ? { entityId } : {};
  return dataSource.getRepository(BusinessUnit).find({ where, order: { name: 'ASC' } });
}

export async function createBusinessUnit(
  dataSource: DataSource,
  actorId: string,
  input: { entityId: string; name: string },
): Promise<BusinessUnit> {
  const entity = await dataSource.getRepository(OrgEntity).findOne({ where: { id: input.entityId } });
  if (!entity) {
    throw new ValidationError('Unknown entityId');
  }

  const buRepo = dataSource.getRepository(BusinessUnit);
  const existing = await buRepo.findOne({ where: { entityId: input.entityId, name: input.name } });
  if (existing) {
    throw new ConflictError(`Business unit '${input.name}' already exists for this entity`);
  }

  const bu = await buRepo.save(buRepo.create({ entityId: input.entityId, name: input.name, isActive: true }));
  await logAuditEvent(dataSource, { actorId, action: 'business_unit.created', afterValue: bu });
  return bu;
}

export async function updateBusinessUnit(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: { name?: string; isActive?: boolean },
): Promise<BusinessUnit> {
  const repo = dataSource.getRepository(BusinessUnit);
  const bu = await repo.findOne({ where: { id } });
  if (!bu) {
    throw new NotFoundError('Business unit not found');
  }
  const before = { name: bu.name, isActive: bu.isActive };
  if (input.name !== undefined) bu.name = input.name;
  if (input.isActive !== undefined) bu.isActive = input.isActive;
  await repo.save(bu);
  await logAuditEvent(dataSource, {
    actorId,
    action: 'business_unit.updated',
    beforeValue: before,
    afterValue: { name: bu.name, isActive: bu.isActive },
  });
  return bu;
}
