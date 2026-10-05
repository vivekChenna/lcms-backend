// test/integration/modules/documents/delete.test.ts
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

describe('DELETE /documents/:id', () => {
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

  function setup() {
    const storage = new InMemoryObjectStorage();
    return { storage, app: buildTestApp(ds, { storage }) };
  }

  const del = (app: ReturnType<typeof buildTestApp>, id: string, userId: string, role: string) =>
    app.inject({ method: 'DELETE', url: `/documents/${id}`, headers: authHeader(app, userId, role) });

  it('lets the uploader soft-delete: 204, hidden from list and download, bytes retained, audited', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    storage.seed(`cases/${caseRow.id}/${doc.id}`, Buffer.from('bytes'), 'application/pdf');

    const res = await del(app, doc.id, repId, 'legal_rep');
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, repId, 'legal_rep') });
    const download = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(204);
    expect(list.json()).toEqual([]);
    expect(download.statusCode).toBe(404);
    expect(storage.objects.has(`cases/${caseRow.id}/${doc.id}`)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.deleted'`);
    expect(audit.afterValue).toMatchObject({ documentId: doc.id, referenceNumber: caseRow.referenceNumber });
    await app.close();
  });

  it('rejects anyone but the uploader, including an admin and a legal_manager, with 403', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const adminId = await seedUserWithRole(ds, 'admin');
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const admin = await del(app, doc.id, adminId, 'admin');
    const manager = await del(app, doc.id, managerId, 'legal_manager');

    expect(admin.statusCode).toBe(403);
    expect(manager.statusCode).toBe(403);
    await app.close();
  });

  it('rejects deleting on a Closed case with 409, even for the uploader', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    const res = await del(app, doc.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
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

    const gone = await del(app, deleted.id, repId, 'legal_rep');
    const hidden = await del(app, live.id, outsiderId, 'requester');

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });

  it('promotes the previous version to head when the latest version is deleted, and numbering never reuses a version number', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'v1.pdf' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const v2 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'v2.pdf', version: 2, rootDocumentId: v1.id, previousVersionId: v1.id });

    const res = await del(app, v2.id, repId, 'legal_rep');
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(204);
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([v1.id]);

    const mp = buildMultipartBody([{ name: 'file', filename: 'v3.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 third') }]);
    const next = await app.inject({
      method: 'POST',
      url: `/documents/${v1.id}/versions`,
      headers: { ...authHeader(app, repId, 'legal_rep'), ...mp.headers },
      payload: mp.payload,
    });
    expect(next.statusCode).toBe(201);
    expect(next.json()).toMatchObject({ version: 3, previousVersionId: v1.id, rootDocumentId: v1.id });
    await app.close();
  });

  it('lets the responder delete their attachment while the request is open, but not after it is answered', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const open = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const openAttachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: responderId, informationRequestId: open.id });
    const answeredAttachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: responderId, informationRequestId: answered.id });

    const whileOpen = await del(app, openAttachment.id, responderId, 'requester');
    const afterAnswer = await del(app, answeredAttachment.id, responderId, 'requester');

    expect(whileOpen.statusCode).toBe(204);
    expect(afterAnswer.statusCode).toBe(409);
    await app.close();
  });
});
