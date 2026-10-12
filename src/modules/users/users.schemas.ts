import { z } from 'zod';
import { ROLE_NAMES } from './entities/role.entity';
import { paginationQuerySchema } from '../../shared/pagination';

export const createUserBodySchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
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
  // true until the user has chosen a password from the emailed link
  isInvited: z.boolean(),
  role: z.enum(ROLE_NAMES),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// POST /users also says whether the invitation email went out (the user exists either way)
export const createUserResponseSchema = userResponseSchema.extend({ inviteEmailSent: z.boolean() });

export const sendPasswordLinkResponseSchema = z.object({ emailSent: z.literal(true) });

export const userListQuerySchema = paginationQuerySchema.extend({
  role: z.enum(ROLE_NAMES).optional(),
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  search: z.string().trim().min(1).optional(),
});

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


export const caseHolderListResponseSchema = z.array(
  z.object({ id: z.string(), fullName: z.string(), designation: z.string().nullable(), role: z.string() }),
);
