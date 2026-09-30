import type { DataSource } from 'typeorm';
import { RoutingRule } from './entities/routing-rule.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role } from '../users/entities/role.entity';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

async function assertValidLegalRep(dataSource: DataSource, userId: string): Promise<void> {
  const user = await dataSource.getRepository(User).findOne({ where: { id: userId } });
  if (!user || !user.isActive) {
    throw new ValidationError('Unknown or inactive targetLegalRepId');
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

// Deactivating a user, or moving them off legal_rep/legal_manager, doesn't
// retarget or delete routing rules that already point at them — it would be
// surprising for an admin action on a *user* to silently rewrite *routing*
// configuration. Instead it deactivates the affected rules: assertValidLegalRep
// already guarantees every active rule's target was eligible when the rule
// was created or last updated, so a rule still active with an ineligible
// target means that target became ineligible after the fact, and leaving it
// active would silently misroute future cases to someone who can no longer
// act on them (code review finding — closes the gap #9's commit message
// described but didn't fully cover).
export async function deactivateRoutingRulesForIneligibleTarget(
  dataSource: DataSource,
  actorId: string,
  targetLegalRepId: string,
): Promise<void> {
  const repo = dataSource.getRepository(RoutingRule);
  const affected = await repo.find({ where: { targetLegalRepId, isActive: true } });
  for (const rule of affected) {
    const before = { id: rule.id, isActive: true };
    rule.isActive = false;
    await repo.save(rule);
    await logAuditEvent(dataSource, {
      actorId,
      action: 'routing_rule.auto_deactivated',
      beforeValue: before,
      afterValue: { id: rule.id, isActive: false, reason: 'target no longer an active legal_rep/legal_manager' },
    });
  }
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
  const before = {
    matchCriteria: rule.matchCriteria,
    targetLegalRepId: rule.targetLegalRepId,
    priorityOrder: rule.priorityOrder,
    isActive: rule.isActive,
  };
  if (input.targetLegalRepId) {
    await assertValidLegalRep(dataSource, input.targetLegalRepId);
    rule.targetLegalRepId = input.targetLegalRepId;
  }
  if (input.matchCriteria !== undefined) rule.matchCriteria = input.matchCriteria;
  if (input.priorityOrder !== undefined) rule.priorityOrder = input.priorityOrder;
  if (input.isActive !== undefined) rule.isActive = input.isActive;
  await repo.save(rule);
  await logAuditEvent(dataSource, { actorId, action: 'routing_rule.updated', beforeValue: before, afterValue: rule });
  return rule;
}
