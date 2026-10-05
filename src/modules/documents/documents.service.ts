// src/modules/documents/documents.service.ts
import crypto from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import type { DataSource, EntityManager } from 'typeorm';
import { CaseDocument } from './entities/case-document.entity';
import { Case } from '../cases/entities/case.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { loadCaseOrThrow, lockCaseOrThrow } from '../cases/cases.workflow.service';
import { assertCaseWriteEligibility } from '../cases/case-access';
import { logAuditEvent } from '../audit/audit.service';
import { PayloadTooLargeError, ValidationError } from '../../shared/errors';
import type { ObjectStorage } from '../../shared/storage/object-storage';
import { normalizeMimeType, validateUploadFile, type DocumentCategory, type UploadConfig } from './upload-config';

export type DocumentsDeps = { dataSource: DataSource; storage: ObjectStorage; uploadConfig: UploadConfig };
export type IncomingFile = { filename: string; mimeType: string; stream: Readable };
export type UploadPlan = { version: number; rootDocumentId: string | null; previousVersionId: string | null };

export function documentStorageKey(caseId: string, documentId: string): string {
  return `cases/${caseId}/${documentId}`;
}

class SizeLimiter extends Transform {
  bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    super();
    this.maxBytes = maxBytes;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new PayloadTooLargeError(`File exceeds the maximum size of ${this.maxBytes} bytes`));
      return;
    }
    callback(null, chunk);
  }
}

type UploadRequest = {
  caseId: string;
  informationRequestId: string | null;
  category: DocumentCategory;
  auditAction: 'document.uploaded' | 'document.version_uploaded';
  // Runs twice: once unlocked before any bytes are read (fast rejection), and
  // once inside the transaction with the case row locked (the authoritative
  // re-check that closes the race with a concurrent close/reassignment).
  authorize: (manager: EntityManager, caseRow: Case) => Promise<UploadPlan>;
};

// The shared upload pipeline: gate -> pre-check -> validate -> stream to
// storage -> (lock case, re-check, insert row, audit) in one transaction. Any
// failure after the bytes were stored deletes the stored object.
export async function performUpload(
  deps: DocumentsDeps,
  actor: Actor,
  file: IncomingFile,
  request: UploadRequest,
): Promise<CaseDocument> {
  try {
    await getCaseById(deps.dataSource, actor, request.caseId);
    await request.authorize(deps.dataSource.manager, await loadCaseOrThrow(deps.dataSource, request.caseId));
    const { filename } = validateUploadFile(deps.uploadConfig, file.filename, file.mimeType);
    const mimeType = normalizeMimeType(file.mimeType);

    const documentId = crypto.randomUUID();
    const key = documentStorageKey(request.caseId, documentId);
    const limiter = new SizeLimiter(deps.uploadConfig.maxBytes);
    const limited = pipeline(file.stream, limiter, () => undefined);
    try {
      await deps.storage.put(key, limited, mimeType);
      if (limiter.bytes === 0) {
        throw new ValidationError('Empty files cannot be uploaded');
      }
      return await deps.dataSource.transaction(async (manager) => {
        const caseRow = await lockCaseOrThrow(manager, request.caseId);
        const plan = await request.authorize(manager, caseRow);
        const repo = manager.getRepository(CaseDocument);
        const document = await repo.save(
          repo.create({
            id: documentId,
            caseId: request.caseId,
            informationRequestId: request.informationRequestId,
            filename,
            mimeType,
            sizeBytes: limiter.bytes,
            category: request.category,
            version: plan.version,
            rootDocumentId: plan.rootDocumentId ?? documentId,
            previousVersionId: plan.previousVersionId,
            uploaderId: actor.id,
            deletedAt: null,
          }),
        );
        await logAuditEvent(manager, {
          actorId: actor.id,
          caseId: request.caseId,
          action: request.auditAction,
          afterValue: {
            documentId: document.id,
            caseId: request.caseId,
            referenceNumber: caseRow.referenceNumber,
            filename: document.filename,
            category: document.category,
            version: document.version,
            informationRequestId: document.informationRequestId,
          },
        });
        return document;
      });
    } catch (error) {
      limited.destroy();
      await deps.storage.delete(key).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    file.stream.resume();
    throw error;
  }
}

export async function uploadCaseDocument(
  deps: DocumentsDeps,
  actor: Actor,
  caseId: string,
  category: DocumentCategory,
  file: IncomingFile,
): Promise<CaseDocument> {
  return performUpload(deps, actor, file, {
    caseId,
    informationRequestId: null,
    category,
    auditAction: 'document.uploaded',
    authorize: async (_manager, caseRow) => {
      assertCaseWriteEligibility(actor, caseRow);
      return { version: 1, rootDocumentId: null, previousVersionId: null };
    },
  });
}
