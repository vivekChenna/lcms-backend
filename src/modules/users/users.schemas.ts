import { z } from 'zod';
import { ROLE_NAMES } from './entities/role.entity';

export const createUserBodySchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  designation: z.string().optional(),
  phone: z.string().optional(),
  departmentId: z.string().uuid().optional(),
  entityId: z.string().uuid().optional(),
  businessUnitId: z.string().uuid().optional(),
});

export const userResponseSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string(),
  designation: z.string().nullable(),
  phone: z.string().nullable(),
  departmentId: z.string().nullable(),
  entityId: z.string().nullable(),
  businessUnitId: z.string().nullable(),
  isActive: z.boolean(),
  role: z.enum(ROLE_NAMES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
