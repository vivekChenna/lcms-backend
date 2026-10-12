import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { authHeader } from '../../helpers/auth-header';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { resetDatabase } from '../../helpers/reset-db';

describe('a legal manager taking up a case themselves', () => {
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

  it('can assign a case to themselves, accept it, and then comment on it', async () => {
    await resetDatabase(ds);
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    const asManager = authHeader(app, managerId, 'legal_manager');

    const assigned = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/assign`, headers: asManager, payload: { targetLegalRepId: managerId } });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().status).toBe('Assigned');
    expect(assigned.json().assignedLegalRepId).toBe(managerId);

    const accepted = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: asManager });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('In Progress');

    const comment = await app.inject({ method: 'POST', url: `/cases/${caseRow.id}/comments`, headers: asManager, payload: { body: 'Taking this one myself.' } });
    expect(comment.statusCode).toBe(201);
    await app.close();
  });
});
