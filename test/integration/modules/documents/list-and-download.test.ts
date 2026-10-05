// test/integration/modules/documents/list-and-download.test.ts
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
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('document list, versions and download', () => {
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

  async function twoVersionChain(caseId: string, uploaderId: string) {
    const v1 = await seedDocument(ds, { caseId, uploaderId, filename: 'v1.pdf' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const v2 = await seedDocument(ds, { caseId, uploaderId, filename: 'v2.pdf', version: 2, rootDocumentId: v1.id, previousVersionId: v1.id });
    return { v1, v2 };
  }

  it('lists only the head of each version chain, newest first, for anyone who can see the case', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const { v2 } = await twoVersionChain(caseRow.id, repId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const other = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'other.pdf' });

    for (const [id, role] of [[repId, 'legal_rep'], [requesterId, 'requester'], [viewerId, 'viewer']] as const) {
      const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, id, role) });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((d: { id: string }) => d.id)).toEqual([other.id, v2.id]);
    }
    await app.close();
  });

  it('includeHistory=true returns every non-deleted version; deleted rows never appear', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const { v1, v2 } = await twoVersionChain(caseRow.id, repId);
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents?includeHistory=true`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.json().map((d: { id: string }) => d.id).sort()).toEqual([v1.id, v2.id].sort());
    await app.close();
  });

  it('filters by informationRequestId', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId });
    const attachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: requesterId, informationRequestId: request.id });
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents?informationRequestId=${request.id}`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.json().map((d: { id: string }) => d.id)).toEqual([attachment.id]);
    await app.close();
  });

  it('returns 404 when listing documents of a case the caller cannot see', async () => {
    const { app } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, outsiderId, 'requester') });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the whole non-deleted chain ascending from any member id', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const { v1, v2 } = await twoVersionChain(caseRow.id, repId);

    const fromOld = await app.inject({ method: 'GET', url: `/documents/${v1.id}/versions`, headers: authHeader(app, repId, 'legal_rep') });
    const fromHead = await app.inject({ method: 'GET', url: `/documents/${v2.id}/versions`, headers: authHeader(app, repId, 'legal_rep') });

    expect(fromOld.json().map((d: { version: number }) => d.version)).toEqual([1, 2]);
    expect(fromHead.json().map((d: { id: string }) => d.id)).toEqual([v1.id, v2.id]);
    await app.close();
  });

  it('returns 404 for the versions of a deleted or invisible document', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });
    const live = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const gone = await app.inject({ method: 'GET', url: `/documents/${deleted.id}/versions`, headers: authHeader(app, repId, 'legal_rep') });
    const hidden = await app.inject({ method: 'GET', url: `/documents/${live.id}/versions`, headers: authHeader(app, outsiderId, 'requester') });

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });

  it('streams the exact bytes with attachment headers, and inline when asked', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const bytes = Buffer.from('%PDF-1.4 real bytes');
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'عقد 2026.pdf', sizeBytes: bytes.length });
    storage.seed(`cases/${caseRow.id}/${doc.id}`, bytes, 'application/pdf');

    const attachment = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download`, headers: authHeader(app, repId, 'legal_rep') });
    const inline = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download?disposition=inline`, headers: authHeader(app, repId, 'legal_rep') });

    expect(attachment.statusCode).toBe(200);
    expect(attachment.rawPayload.equals(bytes)).toBe(true);
    expect(attachment.headers['content-type']).toBe('application/pdf');
    expect(attachment.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(attachment.headers['content-disposition']).toContain(`filename*=UTF-8''%D8%B9%D9%82%D8%AF%202026.pdf`);
    expect(attachment.headers['x-content-type-options']).toBe('nosniff');
    expect(attachment.headers['cache-control']).toBe('private, no-store');
    expect(inline.headers['content-disposition']).toMatch(/^inline; /);
    await app.close();
  });

  it('lets a requester who is only an information-request responder download', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherMaster = await seedCaseMasterData(ds);
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    storage.seed(`cases/${caseRow.id}/${doc.id}`, Buffer.from('x'), 'application/pdf');

    const res = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download`, headers: authHeader(app, responderId, 'requester') });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 404 downloading a deleted document or one on an invisible case, and 400 for a bad disposition', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });
    const live = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const gone = await app.inject({ method: 'GET', url: `/documents/${deleted.id}/download`, headers: authHeader(app, repId, 'legal_rep') });
    const hidden = await app.inject({ method: 'GET', url: `/documents/${live.id}/download`, headers: authHeader(app, outsiderId, 'requester') });
    const bad = await app.inject({ method: 'GET', url: `/documents/${live.id}/download?disposition=evil`, headers: authHeader(app, repId, 'legal_rep') });

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
