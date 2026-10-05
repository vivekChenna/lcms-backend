import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedDocument } from '../../helpers/seed-document';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('POST /documents/:id/versions', () => {
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

  const V2 = Buffer.from('%PDF-1.4 second version');

  async function uploadVersion(app: ReturnType<typeof buildTestApp>, documentId: string, userId: string, role: string, query = '') {
    const mp = buildMultipartBody([{ name: 'file', filename: 'contract-v2.pdf', contentType: 'application/pdf', content: V2 }]);
    return app.inject({
      method: 'POST',
      url: `/documents/${documentId}/versions${query}`,
      headers: { ...authHeader(app, userId, role), ...mp.headers },
      payload: mp.payload,
    });
  }

  function setup() {
    const storage = new InMemoryObjectStorage();
    return { storage, app: buildTestApp(ds, { storage }) };
  }

  it('creates version 2 linked to version 1, inheriting the category, keeping the old bytes, and audits it', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Contract' });
    storage.seed(`cases/${caseRow.id}/${v1.id}`, Buffer.from('v1 bytes'), 'application/pdf');

    const res = await uploadVersion(app, v1.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(201);
    const v2 = res.json();
    expect(v2).toMatchObject({ version: 2, rootDocumentId: v1.id, previousVersionId: v1.id, category: 'Contract', informationRequestId: null });
    expect(storage.objects.get(`cases/${caseRow.id}/${v1.id}`)?.body.toString()).toBe('v1 bytes');
    expect(storage.objects.get(`cases/${caseRow.id}/${v2.id}`)?.body.equals(V2)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.version_uploaded'`);
    expect(audit.afterValue).toMatchObject({ documentId: v2.id, version: 2, referenceNumber: caseRow.referenceNumber });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, repId, 'legal_rep') });
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([v2.id]);
    await app.close();
  });

  it('lets the caller override the category', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Evidence' });

    const res = await uploadVersion(app, v1.id, repId, 'legal_rep', '?category=Legal%20Opinion');

    expect(res.statusCode).toBe(201);
    expect(res.json().category).toBe('Legal Opinion');
    await app.close();
  });

  it('lets any eligible writer (not just the original uploader) add a version', async () => {
    const { app } = setup();
    await app.ready();
    const { requesterId, caseRow, repId } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    const res = await uploadVersion(app, v1.id, requesterId, 'requester');

    expect(res.statusCode).toBe(201);
    expect(res.json().uploaderId).toBe(requesterId);
    await app.close();
  });

  it('rejects versioning anything but the latest version with 409', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, version: 2, rootDocumentId: v1.id, previousVersionId: v1.id });

    const res = await uploadVersion(app, v1.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects versioning an information-request attachment with 409', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId });
    const attachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: requesterId, informationRequestId: request.id });

    const res = await uploadVersion(app, attachment.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects a viewer (403), an unassigned legal_rep (403) and a Closed case (409)', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const closed = await seedCaseWithParties(ds, { status: 'Closed' });
    const closedDoc = await seedDocument(ds, { caseId: closed.caseRow.id, uploaderId: closed.repId });
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');

    const viewer = await uploadVersion(app, v1.id, viewerId, 'viewer');
    const other = await uploadVersion(app, v1.id, otherRepId, 'legal_rep');
    const onClosed = await uploadVersion(app, closedDoc.id, closed.repId, 'legal_rep');

    expect(viewer.statusCode).toBe(403);
    expect(other.statusCode).toBe(403);
    expect(onClosed.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('returns 404 for a deleted document and for a case the caller cannot see', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });
    const live = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const gone = await uploadVersion(app, deleted.id, repId, 'legal_rep');
    const hidden = await uploadVersion(app, live.id, outsiderId, 'requester');

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });
});
