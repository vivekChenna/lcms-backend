import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedDocument } from '../../helpers/seed-document';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('document uploader names', () => {
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

  it('list, upload and versions carry uploadedByName', async () => {
    const app = buildTestApp(ds, { storage: new InMemoryObjectStorage() });
    await app.ready();
    const { caseRow, repId } = await seedCaseWithParties(ds);
    await ds.query(`UPDATE users SET "fullName" = 'Rita Rep' WHERE id = $1`, [repId]);
    const uploaderId = await seedUserWithRole(ds, 'admin', { fullName: 'Uma Uploader' });
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId });
    await seedDocument(ds, { caseId: caseRow.id, uploaderId, version: 2, rootDocumentId: v1.id, previousVersionId: v1.id });
    const headers = authHeader(app, uploaderId, 'admin');

    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents?includeHistory=true`, headers });
    const versions = await app.inject({ method: 'GET', url: `/documents/${v1.id}/versions`, headers });
    const mp = buildMultipartBody([{ name: 'file', filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 x') }]);
    const upload = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/documents?category=Evidence`,
      headers: { ...authHeader(app, repId, 'legal_rep'), ...mp.headers },
      payload: mp.payload,
    });

    expect(list.json().length).toBe(2);
    expect(list.json().every((d: { uploadedByName: string }) => d.uploadedByName === 'Uma Uploader')).toBe(true);
    expect(versions.json().length).toBe(2);
    expect(versions.json().every((d: { uploadedByName: string }) => d.uploadedByName === 'Uma Uploader')).toBe(true);
    expect(upload.statusCode).toBe(201);
    expect(upload.json().uploadedByName).toBe('Rita Rep');
    await app.close();
  });
});
