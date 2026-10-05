// src/modules/documents/documents.routes.ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CaseDocument } from './entities/case-document.entity';
import {
  getDocumentForDownload,
  listCaseDocuments,
  listDocumentVersions,
  documentStorageKey,
  uploadCaseDocument,
  type DocumentsDeps,
  type IncomingFile,
} from './documents.service';
import {
  documentIdParamsSchema,
  documentListResponseSchema,
  documentResponseSchema,
  downloadQuerySchema,
  listDocumentsQuerySchema,
  uploadQuerySchema,
} from './documents.schemas';
import { contentDispositionHeader } from './content-disposition';
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

  typedApp.get('/cases/:id/documents', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      querystring: listDocumentsQuerySchema,
      response: { 200: documentListResponseSchema },
    },
  }, async (request) => {
    const rows = await listCaseDocuments(app.dataSource, request.user, request.params.id, {
      informationRequestId: request.query.informationRequestId,
      includeHistory: request.query.includeHistory,
    });
    return rows.map(serializeDocument);
  });

  typedApp.get('/documents/:id/versions', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      params: documentIdParamsSchema,
      response: { 200: documentListResponseSchema },
    },
  }, async (request) => {
    const rows = await listDocumentVersions(app.dataSource, request.user, request.params.id);
    return rows.map(serializeDocument);
  });

  typedApp.get('/documents/:id/download', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      params: documentIdParamsSchema,
      querystring: downloadQuerySchema,
    },
  }, async (request, reply) => {
    const document = await getDocumentForDownload(app.dataSource, request.user, request.params.id);
    const stream = await options.storage.get(documentStorageKey(document.caseId, document.id));
    reply
      .header('Content-Type', document.mimeType)
      .header('Content-Disposition', contentDispositionHeader(request.query.disposition, document.filename))
      .header('Content-Length', String(document.sizeBytes))
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(stream);
  });

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
