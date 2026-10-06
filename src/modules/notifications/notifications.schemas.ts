import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination';

export const notificationListQuerySchema = paginationQuerySchema.extend({
  isRead: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export const notificationIdParamsSchema = z.object({ id: z.string().uuid() });

export const notificationResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  relatedCaseId: z.string().nullable(),
  relatedCaseReference: z.string().nullable(),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const notificationListResponseSchema = z.object({
  items: z.array(notificationResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  unreadCount: z.number(),
});
