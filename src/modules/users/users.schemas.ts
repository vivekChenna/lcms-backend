import { z } from 'zod';
import { ROLE_NAMES } from './entities/role.entity';
import { paginationQuerySchema } from '../../shared/pagination';

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

export const userListQuerySchema = paginationQuerySchema;

export const userListResponseSchema = z.object({
  items: z.array(userResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export const userIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const updateUserRoleBodySchema = z.object({
  role: z.enum(ROLE_NAMES),
});

export const updateUserBodySchema = z.object({
  fullName: z.string().min(1).optional(),
  designation: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
  businessUnitId: z.string().uuid().nullable().optional(),
});

export const resetPasswordBodySchema = z.object({
  newPassword: z.string().min(8),
});
