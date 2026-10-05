import crypto from 'node:crypto';
import type { DataSource } from 'typeorm';
import { CaseDocument } from '../../../src/modules/documents/entities/case-document.entity';
import type { DocumentCategory } from '../../../src/modules/documents/upload-config';

export async function seedDocument(
  ds: DataSource,
  overrides: {
    caseId: string;
    uploaderId: string;
    id?: string;
    informationRequestId?: string | null;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
    category?: DocumentCategory;
    version?: number;
    rootDocumentId?: string;
    previousVersionId?: string | null;
    deletedAt?: Date | null;
  },
): Promise<CaseDocument> {
  const id = overrides.id ?? crypto.randomUUID();
  const repo = ds.getRepository(CaseDocument);
  return repo.save(
    repo.create({
      id,
      caseId: overrides.caseId,
      informationRequestId: overrides.informationRequestId ?? null,
      filename: overrides.filename ?? 'contract.pdf',
      mimeType: overrides.mimeType ?? 'application/pdf',
      sizeBytes: overrides.sizeBytes ?? 1024,
      category: overrides.category ?? 'Evidence',
      version: overrides.version ?? 1,
      rootDocumentId: overrides.rootDocumentId ?? id,
      previousVersionId: overrides.previousVersionId ?? null,
      uploaderId: overrides.uploaderId,
      deletedAt: overrides.deletedAt ?? null,
    }),
  );
}
