import type { DataSource } from 'typeorm';
import { RoutingRule } from '../master-data/entities/routing-rule.entity';

export type CaseMatchAttrs = {
  categoryId: string;
  caseTypeId: string;
  entityId: string;
  businessUnitId: string | null;
  departmentId: string;
  priority: string;
};

export function matchesCriteria(matchCriteria: Record<string, unknown>, caseAttrs: CaseMatchAttrs): boolean {
  return Object.entries(matchCriteria).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    return (caseAttrs as Record<string, unknown>)[key] === value;
  });
}

export async function evaluateAutoRouting(dataSource: DataSource, caseAttrs: CaseMatchAttrs): Promise<RoutingRule | null> {
  const rules = await dataSource
    .getRepository(RoutingRule)
    .find({ where: { isActive: true }, order: { priorityOrder: 'ASC' } });
  return rules.find((rule) => matchesCriteria(rule.matchCriteria, caseAttrs)) ?? null;
}
