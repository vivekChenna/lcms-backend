import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedInformationRequest } from '../../helpers/seed-information-request';

describe('InformationRequest entity + migration', () => {
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

  it('round-trips an information request row through the repository', async () => {
    await ds.query('DELETE FROM information_requests');
    await ds.query('DELETE FROM cases');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');

    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const responderId = await seedUserWithRole(ds, 'requester');
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const infoRequest = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    expect(infoRequest.id).toBeTruthy();
    expect(infoRequest.status).toBe('open');
    expect(infoRequest.caseId).toBe(caseRow.id);
    expect(infoRequest.reopenedFromId).toBeNull();
    expect(infoRequest.responseText).toBeNull();
  });
});
