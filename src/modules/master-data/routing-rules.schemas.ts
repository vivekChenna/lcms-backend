import { z } from 'zod';

export const routingRuleSchema = z.object({
  id: z.string(),
  matchCriteria: z.record(z.string(), z.unknown()),
  targetLegalRepId: z.string(),
  priorityOrder: z.number(),
  isActive: z.boolean(),
});

export const matchCriteriaSchema = z
  .object({
    categoryId: z.string().uuid().nullable().optional(),
    caseTypeId: z.string().uuid().nullable().optional(),
    entityId: z.string().uuid().nullable().optional(),
    businessUnitId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    priority: z.string().nullable().optional(),
  })
  .strict();

export const createRoutingRuleBodySchema = z.object({
  matchCriteria: matchCriteriaSchema,
  targetLegalRepId: z.string().uuid(),
  priorityOrder: z.number().int().optional(),
});

export const updateRoutingRuleBodySchema = z.object({
  matchCriteria: matchCriteriaSchema.optional(),
  targetLegalRepId: z.string().uuid().optional(),
  priorityOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
