import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination';

export const auditFilterShape = {
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
  caseId: z.string().uuid().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
};
export const dateOrder = (q: { createdFrom?: Date; createdTo?: Date }) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo;
export const dateOrderMessage = { message: 'createdFrom must not be after createdTo', path: ['createdFrom'] };

export const auditQuerySchema = paginationQuerySchema.extend(auditFilterShape).refine(dateOrder, dateOrderMessage);
export const auditExportQuerySchema = z.object(auditFilterShape).refine(dateOrder, dateOrderMessage);

export const auditListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      caseId: z.string().nullable(),
      caseReference: z.string().nullable(),
      actorId: z.string(),
      actorName: z.string().nullable(),
      actorDesignation: z.string().nullable(),
      actorRole: z.string().nullable(),
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
