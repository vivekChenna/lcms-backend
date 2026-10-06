import { z } from 'zod';

const bodySchema = z.string().trim().min(1).max(10000);

export const createCommentBodySchema = z.object({
  body: bodySchema,
  isInternal: z.boolean().default(false),
});

export const editCommentBodySchema = z.object({ body: bodySchema });

export const commentIdParamsSchema = z.object({ id: z.string().uuid() });

export const commentResponseSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  authorId: z.string(),
  authorName: z.string().nullable(),
  authorRole: z.string().nullable(),
  body: z.string(),
  isInternal: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const commentListResponseSchema = z.array(commentResponseSchema);
