import { z } from 'zod';

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshBodySchema = z.object({ refreshToken: z.string().min(1).optional() }).optional();

export const forgotPasswordBodySchema = z.object({ email: z.string().email() });

export const setPasswordBodySchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export const profileSchema = z.object({
  id: z.string(), fullName: z.string(), email: z.string(), designation: z.string().nullable(), role: z.string(),
  departmentId: z.string().nullable(), departmentName: z.string().nullable(),
  entityId: z.string().nullable(), entityName: z.string().nullable(),
  businessUnitId: z.string().nullable(), businessUnitName: z.string().nullable(),
});

export const sessionResponseSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), user: profileSchema });
