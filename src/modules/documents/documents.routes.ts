// src/modules/documents/documents.routes.ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CaseDocument } from './entities/case-document.entity';
import { uploadCaseDocument, type DocumentsDeps, type IncomingFile } from './documents.service';
import { documentResponseSchema, uploadQuerySchema } from './documents.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';
import { ValidationError } from '../../shared/errors';
import type { ObjectStorage } from '../../shared/storage/object-storage';
import type { UploadConfig } from './upload-config';

export type DocumentsRoutesOptions = { storage: ObjectStorage; uploadConfig: UploadConfig };

export function serializeDocument(row: CaseDocument) {
  return {
    id: row.id,
    caseId: row.caseId,
    informationRequestId: row.informationRequestId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    category: row.category,
    version: row.version,
    rootDocumentId: row.rootDocumentId,
    previousVersionId: row.previousVersionId,
    uploaderId: row.uploaderId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function readUpload(request: FastifyRequest): Promise<IncomingFile> {
  if (!request.isMultipart()) {
    throw new ValidationError('Request must be multipart/form-data');
  }
  const part = await request.file();
  if (!part || part.fieldname !== 'file') {
    throw new ValidationError('A file is required in the multipart field "file"');
  }
  return { filename: part.filename, mimeType: part.mimetype, stream: part.file };
}

export default async function documentsRoutes(app: FastifyInstance, options: DocumentsRoutesOptions): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const deps: DocumentsDeps = { dataSource: app.dataSource, storage: options.storage, uploadConfig: options.uploadConfig };

  typedApp.post('/cases/:id/documents', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      params: caseIdParamsSchema,
      querystring: uploadQuerySchema,
      response: { 201: documentResponseSchema },
    },
  }, async (request, reply) => {
    const file = await readUpload(request);
    const document = await uploadCaseDocument(deps, request.user, request.params.id, request.query.category, file);
    reply.status(201).send(serializeDocument(document));
  });
}
