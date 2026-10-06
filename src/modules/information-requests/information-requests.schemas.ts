import { z } from 'zod';

export const INFO_REQUEST_STATUSES = ['open', 'answered', 'superseded'] as const;

export const raiseInformationRequestBodySchema = z.object({
  subject: z.string().min(1),
  requirementDescription: z.string().min(1),
  responderId: z.string().uuid(),
  dueDate: z.coerce.date().optional(),
});

export const respondInformationRequestBodySchema = z.object({
  responseText: z.string().min(1),
});

export const reopenInformationRequestBodySchema = z.object({
  comment: z.string().min(1),
});

export const informationRequestIdParamsSchema = z.object({ id: z.string().uuid() });

export const informationRequestResponseSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  subject: z.string(),
  requirementDescription: z.string(),
  raisedById: z.string(),
  raisedByName: z.string().nullable(),
  raisedByRole: z.string().nullable(),
  responderId: z.string(),
  responderName: z.string().nullable(),
  dueDate: z.string().nullable(),
  status: z.enum(INFO_REQUEST_STATUSES),
  responseText: z.string().nullable(),
  reopenedFromId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const informationRequestListResponseSchema = z.array(informationRequestResponseSchema);
