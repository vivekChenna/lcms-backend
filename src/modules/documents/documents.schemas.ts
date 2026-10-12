// src/modules/documents/documents.schemas.ts
import { z } from 'zod';
import { DOCUMENT_CATEGORIES } from './upload-config';

export const documentCategorySchema = z.enum(DOCUMENT_CATEGORIES);

export const uploadQuerySchema = z.object({ category: documentCategorySchema });

export const documentResponseSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  informationRequestId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  category: documentCategorySchema,
  version: z.number(),
  rootDocumentId: z.string(),
  previousVersionId: z.string().nullable(),
  uploaderId: z.string(),
  uploadedByName: z.string().nullable(),
  uploadedByDesignation: z.string().nullable(),
  createdAt: z.string(),
});
export const documentIdParamsSchema = z.object({ id: z.string().uuid() });

export const listDocumentsQuerySchema = z.object({
  informationRequestId: z.string().uuid().optional(),
  includeHistory: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

export const downloadQuerySchema = z.object({
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
});

export const documentListResponseSchema = z.array(documentResponseSchema);

export const newVersionQuerySchema = z.object({ category: documentCategorySchema.optional() });
