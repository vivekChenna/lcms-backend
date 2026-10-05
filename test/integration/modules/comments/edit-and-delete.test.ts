// test/integration/modules/comments/edit-and-delete.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedComment } from '../../helpers/seed-comment';
import { authHeader } from '../../helpers/auth-header';

describe('PATCH/DELETE /comments/:id', () => {
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

  it('lets the author edit their own comment and audits old and new body', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: requesterId, body: 'Typo here' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/comments/${comment.id}`,
      headers: authHeader(app, requesterId, 'requester'),
      payload: { body: 'Fixed text' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('Fixed text');
    const [audit] = await ds.query(`SELECT "beforeValue", "afterValue" FROM audit_log WHERE action = 'comment.edited'`);
    expect(audit.beforeValue.body).toBe('Typo here');
    expect(audit.afterValue).toMatchObject({ body: 'Fixed text', referenceNumber: caseRow.referenceNumber });
    await app.close();
  });

  it('rejects editing or deleting someone else\'s comment, even by an admin or manager (VC-17)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: requesterId });
    const adminId = await seedUserWithRole(ds, 'admin');
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const adminEdit = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, adminId, 'admin'), payload: { body: 'x' } });
    const managerDelete = await app.inject({ method: 'DELETE', url: `/comments/${comment.id}`, headers: authHeader(app, managerId, 'legal_manager') });

    expect(adminEdit.statusCode).toBe(403);
    expect(managerDelete.statusCode).toBe(403);
    await app.close();
  });

  it('soft-deletes the author\'s own comment: 204, hidden from the list, row kept, audited', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'to delete' });

    const res = await app.inject({ method: 'DELETE', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep') });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(204);
    expect(list.json()).toEqual([]);
    const [row] = await ds.query(`SELECT "deletedAt" FROM comments WHERE id = $1`, [comment.id]);
    expect(row.deletedAt).not.toBeNull();
    const audits = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'comment.deleted'`);
    expect(audits).toHaveLength(1);
    expect(audits[0].afterValue.referenceNumber).toBe(caseRow.referenceNumber);
    await app.close();
  });

  it('returns 404 for a missing or already-deleted comment', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedComment(ds, { caseId: caseRow.id, authorId: repId, deletedAt: new Date() });

    const gone = await app.inject({ method: 'PATCH', url: `/comments/${deleted.id}`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: 'x' } });
    const missing = await app.inject({ method: 'DELETE', url: '/comments/6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e', headers: authHeader(app, repId, 'legal_rep') });

    expect(gone.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('reports an internal note as 404 (not 403) to a requester, so its existence is not leaked', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const note = await seedComment(ds, { caseId: caseRow.id, authorId: repId, isInternal: true });

    const edit = await app.inject({ method: 'PATCH', url: `/comments/${note.id}`, headers: authHeader(app, requesterId, 'requester'), payload: { body: 'x' } });
    const del = await app.inject({ method: 'DELETE', url: `/comments/${note.id}`, headers: authHeader(app, requesterId, 'requester') });

    expect(edit.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for a comment on a case the caller cannot see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, outsiderId, 'requester'), payload: { body: 'x' } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects edit and delete on a Closed case with 409, even for the author', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId });

    const edit = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: 'x' } });
    const del = await app.inject({ method: 'DELETE', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep') });

    expect(edit.statusCode).toBe(409);
    expect(del.statusCode).toBe(409);
    await app.close();
  });

  it('rejects an edit to a whitespace-only body with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId });

    const res = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: '  ' } });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
