import { z } from 'zod';

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export const sessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({
    id: z.string(),
    role: z.string(),
    departmentId: z.string().nullable(),
    entityId: z.string().nullable(),
    businessUnitId: z.string().nullable(),
  }),
});
