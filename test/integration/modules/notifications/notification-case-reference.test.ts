import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedNotification } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('notification case reference', () => {
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

  it('list and mark-read carry relatedCaseReference, null without a case', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow, requesterId } = await seedCaseWithParties(ds);
    const withCase = await seedNotification(ds, { userId: requesterId, relatedCaseId: caseRow.id });
    const without = await seedNotification(ds, { userId: requesterId, relatedCaseId: null });
    const headers = authHeader(app, requesterId, 'requester');

    const list = await app.inject({ method: 'GET', url: '/notifications', headers });
    const read = await app.inject({ method: 'PATCH', url: `/notifications/${withCase.id}/read`, headers });
    const readNone = await app.inject({ method: 'PATCH', url: `/notifications/${without.id}/read`, headers });

    const byId = (id: string) => list.json().items.find((i: { id: string }) => i.id === id);
    expect(byId(withCase.id).relatedCaseReference).toBe(caseRow.referenceNumber);
    expect(byId(without.id).relatedCaseReference).toBeNull();
    expect(read.json().relatedCaseReference).toBe(caseRow.referenceNumber);
    expect(readNone.json().relatedCaseReference).toBeNull();
    await app.close();
  });
});
