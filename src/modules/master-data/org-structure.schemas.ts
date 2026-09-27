import { z } from 'zod';

export const entitySchema = z.object({ id: z.string(), name: z.string(), code: z.string(), isActive: z.boolean() });
export const createEntityBodySchema = z.object({ name: z.string().min(1), code: z.string().min(1) });
export const updateEntityBodySchema = z.object({ name: z.string().min(1).optional(), code: z.string().min(1).optional(), isActive: z.boolean().optional() });

export const businessUnitSchema = z.object({ id: z.string(), entityId: z.string(), name: z.string(), isActive: z.boolean() });
export const createBusinessUnitBodySchema = z.object({ entityId: z.string().uuid(), name: z.string().min(1) });
export const updateBusinessUnitBodySchema = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional() });
export const listBusinessUnitsQuerySchema = z.object({ entityId: z.string().uuid().optional() });

export const idParamsSchema = z.object({ id: z.string().uuid() });
