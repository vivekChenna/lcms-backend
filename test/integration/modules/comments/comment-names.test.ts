import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedComment } from '../../helpers/seed-comment';
import { authHeader } from '../../helpers/auth-header';

describe('comment author names', () => {
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

  it('list, create and edit carry authorName and authorRole, and a requester sees the lawyer name', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow, repId, requesterId } = await seedCaseWithParties(ds);
    await ds.query(`UPDATE users SET "fullName" = 'Lina Lawyer' WHERE id = $1`, [repId]);
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'From the lawyer' });

    const asRequester = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, requesterId, 'requester') });
    const created = await app.inject({ method: 'POST', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: 'Another' } });
    const edited = await app.inject({ method: 'PATCH', url: `/comments/${created.json().id}`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: 'Edited' } });

    expect(asRequester.json()[0]).toMatchObject({ authorName: 'Lina Lawyer', authorRole: 'legal_rep' });
    expect(created.json()).toMatchObject({ authorName: 'Lina Lawyer', authorRole: 'legal_rep' });
    expect(edited.json()).toMatchObject({ authorName: 'Lina Lawyer', authorRole: 'legal_rep' });
    await app.close();
  });
});
