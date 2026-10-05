// test/integration/modules/documents/upload.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';
import type { UploadConfig } from '../../../../src/modules/documents/upload-config';

describe('POST /cases/:id/documents', () => {
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

  const PDF = Buffer.from('%PDF-1.4 test document');

  async function upload(
    app: ReturnType<typeof buildTestApp>,
    caseId: string,
    userId: string,
    role: string,
    options: { filename?: string; contentType?: string; content?: Buffer; query?: string } = {},
  ) {
    const mp = buildMultipartBody([
      { name: 'file', filename: options.filename ?? 'contract.pdf', contentType: options.contentType ?? 'application/pdf', content: options.content ?? PDF },
    ]);
    return app.inject({
      method: 'POST',
      url: `/cases/${caseId}/documents${options.query ?? '?category=Evidence'}`,
      headers: { ...authHeader(app, userId, role), ...mp.headers },
      payload: mp.payload,
    });
  }

  function setup(uploadConfig?: Partial<UploadConfig>) {
    const storage = new InMemoryObjectStorage();
    const app = buildTestApp(ds, { storage, uploadConfig });
    return { storage, app };
  }

  it('lets the assigned legal_rep upload; stores the exact bytes under cases/{caseId}/{id}; audits it', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      caseId: caseRow.id,
      informationRequestId: null,
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      category: 'Evidence',
      version: 1,
      rootDocumentId: body.id,
      previousVersionId: null,
      uploaderId: repId,
    });
    expect(storage.objects.get(`cases/${caseRow.id}/${body.id}`)?.body.equals(PDF)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.uploaded'`);
    expect(audit.afterValue).toMatchObject({ documentId: body.id, referenceNumber: caseRow.referenceNumber, filename: 'contract.pdf', category: 'Evidence', version: 1 });
    await app.close();
  });

  it('lets a requester in the case department upload', async () => {
    const { app } = setup();
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, requesterId, 'requester');

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('lets a requester who sees the case only as an information-request responder upload', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherMaster = await seedCaseMasterData(ds);
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const res = await upload(app, caseRow.id, responderId, 'requester');

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('lets a legal_manager and an admin upload to a case that is still Assigned', async () => {
    const { app } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const adminId = await seedUserWithRole(ds, 'admin');

    const manager = await upload(app, caseRow.id, managerId, 'legal_manager');
    const admin = await upload(app, caseRow.id, adminId, 'admin');

    expect(manager.statusCode).toBe(201);
    expect(admin.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a viewer, a legal_rep who is not assigned, and a legal_rep who has not accepted (403)', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const unaccepted = await seedCaseWithParties(ds, { status: 'Assigned' });
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');

    const viewer = await upload(app, caseRow.id, viewerId, 'viewer');
    const other = await upload(app, caseRow.id, otherRepId, 'legal_rep');
    const notAccepted = await upload(app, unaccepted.caseRow.id, unaccepted.repId, 'legal_rep');

    expect(viewer.statusCode).toBe(403);
    expect(other.statusCode).toBe(403);
    expect(notAccepted.statusCode).toBe(403);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('rejects an upload to a Closed case with 409', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });

    const res = await upload(app, caseRow.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('returns 404 for a requester who cannot see the case', async () => {
    const { app } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await upload(app, caseRow.id, outsiderId, 'requester');

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a disallowed extension, a mismatched mime type, a missing and an unknown category with 400, storing nothing', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const exe = await upload(app, caseRow.id, repId, 'legal_rep', { filename: 'virus.exe', contentType: 'application/octet-stream' });
    const mismatch = await upload(app, caseRow.id, repId, 'legal_rep', { filename: 'a.pdf', contentType: 'image/png' });
    const noCategory = await upload(app, caseRow.id, repId, 'legal_rep', { query: '' });
    const badCategory = await upload(app, caseRow.id, repId, 'legal_rep', { query: '?category=Secrets' });

    expect(exe.statusCode).toBe(400);
    expect(mismatch.statusCode).toBe(400);
    expect(noCategory.statusCode).toBe(400);
    expect(badCategory.statusCode).toBe(400);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('rejects an oversize file with 413 and leaves nothing in storage or the database', async () => {
    const { app, storage } = setup({ maxBytes: 10 });
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep', { content: Buffer.alloc(64, 1) });

    expect(res.statusCode).toBe(413);
    expect(storage.objects.size).toBe(0);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM documents`);
    expect(count).toBe(0);
    await app.close();
  });

  it('rejects a zero-byte file with 400 and leaves nothing in storage', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep', { content: Buffer.alloc(0) });

    expect(res.statusCode).toBe(400);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('sanitizes path separators out of the filename and keeps them out of the storage key', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep', { filename: '../../etc/evil.pdf' });

    expect(res.statusCode).toBe(201);
    expect(res.json().filename).toBe('evil.pdf');
    for (const key of storage.objects.keys()) {
      expect(key).toMatch(/^cases\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    }
    await app.close();
  });

  it('keeps a non-ASCII filename and truncates an over-long one to 255 characters, extension intact', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const arabic = await upload(app, caseRow.id, repId, 'legal_rep', { filename: 'عقد-2026.pdf' });
    const long = await upload(app, caseRow.id, repId, 'legal_rep', { filename: `${'a'.repeat(400)}.pdf` });

    expect(arabic.statusCode).toBe(201);
    expect(arabic.json().filename).toBe('عقد-2026.pdf');
    expect(long.statusCode).toBe(201);
    expect(long.json().filename.length).toBe(255);
    expect(long.json().filename.endsWith('.pdf')).toBe(true);
    await app.close();
  });

  it('rejects a non-multipart request with 400', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/documents?category=Evidence`,
      headers: { ...authHeader(app, repId, 'legal_rep'), 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('never lets an upload commit after a concurrent close: the case lock forces 409 and the stored object is cleaned up', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    // Hold the case row lock in a separate transaction and close the case inside it.
    const queryRunner = ds.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query(`SELECT id FROM cases WHERE id = $1 FOR UPDATE`, [caseRow.id]);

    const pending = upload(app, caseRow.id, repId, 'legal_rep');
    // Wait until the upload request is actually blocked on the case row lock.
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const rows = await ds.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' LIMIT 1`,
      );
      blocked = rows.length > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!blocked) {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
      await pending.catch(() => undefined);
      throw new Error('upload request never reached the case row lock within 5s');
    }
    await queryRunner.query(`UPDATE cases SET status = 'Closed' WHERE id = $1`, [caseRow.id]);
    await queryRunner.commitTransaction();
    await queryRunner.release();
    const res = await pending;

    expect(res.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM documents`);
    expect(count).toBe(0);
    await app.close();
  });

  it('rejects a multipart body with a large non-file field before the file with 413, storing nothing', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const boundary = '----lcmstestbigfield';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n`, 'utf8'),
      Buffer.alloc(64 * 1024, 'x'),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="contract.pdf"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'),
      PDF,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/documents?category=Evidence`,
      headers: { ...authHeader(app, repId, 'legal_rep'), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(413);
    expect(storage.objects.size).toBe(0);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM documents`);
    expect(count).toBe(0);
    await app.close();
  });

  it('rejects a file part sent under the wrong field name with 400, storing nothing', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const mp = buildMultipartBody([{ name: 'attachment', filename: 'contract.pdf', contentType: 'application/pdf', content: PDF }]);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/documents?category=Evidence`,
      headers: { ...authHeader(app, repId, 'legal_rep'), ...mp.headers },
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(storage.objects.size).toBe(0);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM documents`);
    expect(count).toBe(0);
    await app.close();
  });
});
