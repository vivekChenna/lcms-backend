import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData, seedCase } from '../../helpers/seed-case';
import { resetDatabase } from '../../helpers/reset-db';
import { markCaseWaitingOnInput, markCaseInProgress } from '../../../../src/modules/cases/cases.workflow.service';

describe('markCaseWaitingOnInput / markCaseInProgress', () => {
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

  async function reset() {
    await resetDatabase(ds);
  }

  it('moves an In Progress case to Waiting on Input and logs an audit entry', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const updated = await markCaseWaitingOnInput(ds, repId, caseRow.id);

    expect(updated.status).toBe('Waiting on Input');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.waiting_on_input'`);
    expect(auditRows).toHaveLength(1);
  });

  it('no-ops (no mutation, no audit) when the case is already Waiting on Input', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const updated = await markCaseWaitingOnInput(ds, repId, caseRow.id);

    expect(updated.status).toBe('Waiting on Input');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.waiting_on_input'`);
    expect(auditRows).toHaveLength(0);
  });

  it('moves a Waiting on Input case back to In Progress and logs an audit entry', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: repId, assignmentAcceptedAt: new Date() });

    const updated = await markCaseInProgress(ds, repId, caseRow.id);

    expect(updated.status).toBe('In Progress');
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.resumed_in_progress'`);
    expect(auditRows).toHaveLength(1);
  });

  it('rejects moving a Submitted case to Waiting on Input (invalid transition)', async () => {
    await reset();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });

    await expect(markCaseWaitingOnInput(ds, requesterId, caseRow.id)).rejects.toThrow();
  });
});
