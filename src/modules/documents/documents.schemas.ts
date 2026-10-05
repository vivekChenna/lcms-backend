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
  createdAt: z.string(),
});
