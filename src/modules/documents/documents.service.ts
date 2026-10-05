// src/modules/documents/documents.service.ts
import crypto from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { CaseDocument } from './entities/case-document.entity';
import { Case } from '../cases/entities/case.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { loadCaseOrThrow, lockCaseOrThrow } from '../cases/cases.workflow.service';
import { assertCaseWriteEligibility } from '../cases/case-access';
import { logAuditEvent } from '../audit/audit.service';
import { ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, ValidationError } from '../../shared/errors';
import { InformationRequest } from '../information-requests/entities/information-request.entity';
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

export async function findLiveDocument(source: DataSource | EntityManager, documentId: string): Promise<CaseDocument> {
  const document = await source.getRepository(CaseDocument).findOne({ where: { id: documentId, deletedAt: IsNull() } });
  if (!document) {
    throw new NotFoundError('Document not found');
  }
  return document;
}

export async function listCaseDocuments(
  dataSource: DataSource,
  actor: Actor,
  caseId: string,
  options: { informationRequestId?: string; includeHistory: boolean },
): Promise<CaseDocument[]> {
  await getCaseById(dataSource, actor, caseId);
  const rows = await dataSource.getRepository(CaseDocument).find({
    where: {
      caseId,
      deletedAt: IsNull(),
      ...(options.informationRequestId ? { informationRequestId: options.informationRequestId } : {}),
    },
    order: { createdAt: 'DESC' },
  });
  if (options.includeHistory) {
    return rows;
  }
  // Head of each chain = highest version among the non-deleted rows.
  const heads = new Map<string, CaseDocument>();
  for (const row of rows) {
    const current = heads.get(row.rootDocumentId);
    if (!current || row.version > current.version) {
      heads.set(row.rootDocumentId, row);
    }
  }
  return rows.filter((row) => heads.get(row.rootDocumentId)?.id === row.id);
}

export async function listDocumentVersions(dataSource: DataSource, actor: Actor, documentId: string): Promise<CaseDocument[]> {
  const document = await findLiveDocument(dataSource, documentId);
  await getCaseById(dataSource, actor, document.caseId);
  return dataSource.getRepository(CaseDocument).find({
    where: { rootDocumentId: document.rootDocumentId, deletedAt: IsNull() },
    order: { version: 'ASC' },
  });
}

export async function getDocumentForDownload(dataSource: DataSource, actor: Actor, documentId: string): Promise<CaseDocument> {
  const document = await findLiveDocument(dataSource, documentId);
  await getCaseById(dataSource, actor, document.caseId);
  return document;
}

export async function uploadNewVersion(
  deps: DocumentsDeps,
  actor: Actor,
  documentId: string,
  category: DocumentCategory | undefined,
  file: IncomingFile,
): Promise<CaseDocument> {
  let target: CaseDocument;
  try {
    target = await findLiveDocument(deps.dataSource, documentId);
  } catch (error) {
    file.stream.resume();
    throw error;
  }
  return performUpload(deps, actor, file, {
    caseId: target.caseId,
    informationRequestId: null,
    category: category ?? target.category,
    auditAction: 'document.version_uploaded',
    authorize: async (manager, caseRow) => {
      assertCaseWriteEligibility(actor, caseRow);
      const repo = manager.getRepository(CaseDocument);
      const current = await findLiveDocument(manager, documentId);
      if (current.informationRequestId) {
        throw new ConflictError('Information-request attachments cannot be versioned');
      }
      const head = await repo.findOne({
        where: { rootDocumentId: current.rootDocumentId, deletedAt: IsNull() },
        order: { version: 'DESC' },
      });
      if (!head || head.id !== current.id) {
        throw new ConflictError('Only the latest version of a document can be superseded');
      }
      // Number past every version ever stored for this chain, deleted ones
      // included, so a version number is never reused.
      const { max } = (await repo
        .createQueryBuilder('d')
        .select('MAX(d."version")', 'max')
        .where('d."rootDocumentId" = :root', { root: current.rootDocumentId })
        .getRawOne<{ max: number | null }>()) ?? { max: current.version };
      return { version: Number(max ?? current.version) + 1, rootDocumentId: current.rootDocumentId, previousVersionId: current.id };
    },
  });
}

export async function uploadInformationRequestAttachment(
  deps: DocumentsDeps,
  actor: Actor,
  requestId: string,
  category: DocumentCategory,
  file: IncomingFile,
): Promise<CaseDocument> {
  let informationRequest: InformationRequest | null;
  try {
    informationRequest = await deps.dataSource.getRepository(InformationRequest).findOne({ where: { id: requestId } });
    if (!informationRequest) {
      throw new NotFoundError('Information request not found');
    }
  } catch (error) {
    file.stream.resume();
    throw error;
  }
  // Only the responder may attach (AC-15), whatever their role, and only while
  // the request is open — so the general write-eligibility rule (which bars
  // viewers) deliberately does not apply here.
  return performUpload(deps, actor, file, {
    caseId: informationRequest.caseId,
    informationRequestId: informationRequest.id,
    category,
    auditAction: 'document.uploaded',
    authorize: async (manager) => {
      const current = await manager.getRepository(InformationRequest).findOne({ where: { id: requestId } });
      if (!current) {
        throw new NotFoundError('Information request not found');
      }
      if (current.responderId !== actor.id) {
        throw new ForbiddenError('Only the assigned responder can attach files to this information request');
      }
      if (current.status !== 'open') {
        throw new ConflictError('Attachments can only be added while the information request is open');
      }
      return { version: 1, rootDocumentId: null, previousVersionId: null };
    },
  });
}
