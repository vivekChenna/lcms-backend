// test/integration/modules/documents/information-request-attachments.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('POST /information-requests/:id/attachments', () => {
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

  async function attach(app: ReturnType<typeof buildTestApp>, requestId: string, userId: string, role: string) {
    const mp = buildMultipartBody([{ name: 'file', filename: 'answer.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 answer') }]);
    return app.inject({
      method: 'POST',
      url: `/information-requests/${requestId}/attachments?category=Correspondence`,
      headers: { ...authHeader(app, userId, role), ...mp.headers },
      payload: mp.payload,
    });
  }

  function setup() {
    const storage = new InMemoryObjectStorage();
    return { storage, app: buildTestApp(ds, { storage }) };
  }

  it('lets the responder attach a file to an open request; it is linked to the request and audited', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const res = await attach(app, request.id, responderId, 'requester');

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ caseId: caseRow.id, informationRequestId: request.id, category: 'Correspondence', version: 1, uploaderId: responderId });
    expect(storage.objects.has(`cases/${caseRow.id}/${body.id}`)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.uploaded'`);
    expect(audit.afterValue).toMatchObject({ informationRequestId: request.id, referenceNumber: caseRow.referenceNumber });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents?informationRequestId=${request.id}`, headers: authHeader(app, repId, 'legal_rep') });
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([body.id]);
    await app.close();
  });

  it('lets a responder of any role attach, including a legal_rep and a viewer (AC-15: only the responder answers)', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const byRep = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: otherRepId });
    const byViewer = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: viewerId });

    const repRes = await attach(app, byRep.id, otherRepId, 'legal_rep');
    const viewerRes = await attach(app, byViewer.id, viewerId, 'viewer');

    expect(repRes.statusCode).toBe(201);
    expect(viewerRes.statusCode).toBe(201);
    await app.close();
  });

  it('rejects anyone who is not the responder, including the raising lawyer, with 403', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const raiser = await attach(app, request.id, repId, 'legal_rep');
    const colleague = await attach(app, request.id, requesterId, 'requester');

    expect(raiser.statusCode).toBe(403);
    expect(colleague.statusCode).toBe(403);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('rejects an answered or superseded request with 409', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const superseded = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'superseded' });

    const a = await attach(app, answered.id, responderId, 'requester');
    const s = await attach(app, superseded.id, responderId, 'requester');

    expect(a.statusCode).toBe(409);
    expect(s.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('allows attaching again to the open request created by reopening', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const first = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'superseded' });
    const reopened = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, reopenedFromId: first.id });

    const res = await attach(app, reopened.id, responderId, 'requester');

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('returns 404 for an unknown request id', async () => {
    const { app } = setup();
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');

    const res = await attach(app, '6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e', userId, 'requester');

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
