import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination';

export const auditQuerySchema = paginationQuerySchema.extend({
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
  caseId: z.string().uuid().optional(),
});

export const auditListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      caseId: z.string().nullable(),
      actorId: z.string(),
      action: z.string(),
      beforeValue: z.unknown().nullable(),
      afterValue: z.unknown().nullable(),
      createdAt: z.string(),
    }),
  ),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
