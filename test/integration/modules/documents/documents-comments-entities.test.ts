import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedDocument } from '../../helpers/seed-document';
import { seedComment } from '../../helpers/seed-comment';
import { CaseDocument } from '../../../../src/modules/documents/entities/case-document.entity';

describe('documents and comments entities + migration', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('round-trips a first-version document, defaulting root to itself', async () => {
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    expect(doc.id).toBeTruthy();
    expect(doc.version).toBe(1);
    expect(doc.rootDocumentId).toBe(doc.id);
    expect(doc.previousVersionId).toBeNull();
    expect(doc.informationRequestId).toBeNull();
    expect(doc.deletedAt).toBeNull();
    expect(typeof doc.sizeBytes).toBe('number');
  });

  it('links a second version to the first and reads sizeBytes back as a number', async () => {
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, sizeBytes: 5_000_000_000 });

    const v2 = await seedDocument(ds, {
      caseId: caseRow.id,
      uploaderId: repId,
      version: 2,
      rootDocumentId: v1.id,
      previousVersionId: v1.id,
    });

    expect(v2.rootDocumentId).toBe(v1.id);
    expect(v2.previousVersionId).toBe(v1.id);
    const reloaded = await ds.getRepository(CaseDocument).findOneByOrFail({ id: v1.id });
    expect(reloaded.sizeBytes).toBe(5_000_000_000);
  });

  it('round-trips a comment with an internal flag', async () => {
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'Privileged note', isInternal: true });

    expect(comment.isInternal).toBe(true);
    expect(comment.deletedAt).toBeNull();
    expect(comment.createdAt).toBeInstanceOf(Date);
  });

  it('seedCaseWithParties maps status to an accepted/unaccepted assignment', async () => {
    const accepted = await seedCaseWithParties(ds, { status: 'In Progress' });
    expect(accepted.caseRow.assignedLegalRepId).toBe(accepted.repId);
    expect(accepted.caseRow.assignmentAcceptedAt).toBeInstanceOf(Date);

    const submitted = await seedCaseWithParties(ds, { status: 'Submitted' });
    expect(submitted.caseRow.assignedLegalRepId).toBeNull();
  });
});
