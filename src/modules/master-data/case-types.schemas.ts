import { z } from 'zod';

export const caseTypeSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  slaAckHours: z.number(),
  slaResolutionHours: z.number(),
  isActive: z.boolean(),
});

export const createCaseTypeBodySchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  slaAckHours: z.number().int().positive(),
  slaResolutionHours: z.number().int().positive(),
});

export const updateCaseTypeBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  slaAckHours: z.number().int().positive().optional(),
  slaResolutionHours: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

export const listCaseTypesQuerySchema = z.object({ categoryId: z.string().uuid().optional() });
