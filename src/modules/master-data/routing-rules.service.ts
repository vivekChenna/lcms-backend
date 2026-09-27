import type { DataSource } from 'typeorm';
import { RoutingRule } from './entities/routing-rule.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role } from '../users/entities/role.entity';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

async function assertValidLegalRep(dataSource: DataSource, userId: string): Promise<void> {
  const user = await dataSource.getRepository(User).findOne({ where: { id: userId } });
  if (!user) {
    throw new ValidationError('Unknown targetLegalRepId');
  }
  const userRole = await dataSource.getRepository(UserRole).findOne({ where: { userId } });
  const role = userRole ? await dataSource.getRepository(Role).findOne({ where: { id: userRole.roleId } }) : null;
  if (!role || (role.name !== 'legal_rep' && role.name !== 'legal_manager')) {
    throw new ValidationError('targetLegalRepId must belong to a legal_rep or legal_manager (VC-07)');
  }
}

export async function listRoutingRules(dataSource: DataSource): Promise<RoutingRule[]> {
  return dataSource.getRepository(RoutingRule).find({ order: { priorityOrder: 'ASC' } });
}

export type CreateRoutingRuleInput = {
  matchCriteria: Record<string, unknown>;
  targetLegalRepId: string;
  priorityOrder?: number;
};

export async function createRoutingRule(
  dataSource: DataSource,
  actorId: string,
  input: CreateRoutingRuleInput,
): Promise<RoutingRule> {
  await assertValidLegalRep(dataSource, input.targetLegalRepId);

  const repo = dataSource.getRepository(RoutingRule);
  const rule = await repo.save(
    repo.create({
      matchCriteria: input.matchCriteria,
      targetLegalRepId: input.targetLegalRepId,
      priorityOrder: input.priorityOrder ?? 0,
      isActive: true,
    }),
  );
  await logAuditEvent(dataSource, { actorId, action: 'routing_rule.created', afterValue: rule });
  return rule;
}

export async function updateRoutingRule(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: Partial<CreateRoutingRuleInput> & { isActive?: boolean },
): Promise<RoutingRule> {
  const repo = dataSource.getRepository(RoutingRule);
  const rule = await repo.findOne({ where: { id } });
  if (!rule) {
    throw new NotFoundError('Routing rule not found');
  }
  if (input.targetLegalRepId) {
    await assertValidLegalRep(dataSource, input.targetLegalRepId);
    rule.targetLegalRepId = input.targetLegalRepId;
  }
  const before = {
    matchCriteria: rule.matchCriteria,
    targetLegalRepId: rule.targetLegalRepId,
    priorityOrder: rule.priorityOrder,
    isActive: rule.isActive,
  };
  if (input.matchCriteria !== undefined) rule.matchCriteria = input.matchCriteria;
  if (input.priorityOrder !== undefined) rule.priorityOrder = input.priorityOrder;
  if (input.isActive !== undefined) rule.isActive = input.isActive;
  await repo.save(rule);
  await logAuditEvent(dataSource, { actorId, action: 'routing_rule.updated', beforeValue: before, afterValue: rule });
  return rule;
}
