// test/integration/modules/notifications/case-event-helpers.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { listNotificationsFor } from '../../helpers/seed-notification';
import {
  activeLegalManagerIds,
  notifyAssignmentRejected,
  notifyCaseAccepted,
  notifyCaseAssigned,
  notifyCaseClosed,
  notifyCaseRegistered,
  notifySlaBreached,
} from '../../../../src/modules/notifications/notifications.events';

describe('case lifecycle notification helpers', () => {
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

  it('notifyCaseRegistered tells the submitting requester only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);

    await notifyCaseRegistered(ds, caseRow);

    const rows = await listNotificationsFor(ds, requesterId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'case.registered', relatedCaseId: caseRow.id, isRead: false, emailStatus: 'pending' });
    expect(rows[0].title).toContain(caseRow.referenceNumber);
    expect(rows[0].body).toContain(caseRow.referenceNumber);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });

  it('writes the full case title in the body but never the description, and keeps the subject on one line', async () => {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const hostileTitle = 'Dispute "Acme"\r\nBcc: attacker@evil.test — عقد ' + 'long '.repeat(80);
    const caseRow = await seedCase(ds, { ...master, requesterId, title: hostileTitle, description: 'CONFIDENTIAL DESCRIPTION TEXT 1234567890', status: 'Assigned', assignedLegalRepId: repId });

    await notifyCaseRegistered(ds, caseRow);

    const [row] = await listNotificationsFor(ds, requesterId);
    expect(row.title).not.toMatch(/[\r\n]/);
    expect(row.title.length).toBeLessThanOrEqual(200);
    expect(row.body).toContain(hostileTitle);
    expect(row.body).not.toContain('CONFIDENTIAL DESCRIPTION');
  });

  it('skips an inactive requester', async () => {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, isActive: false });
    const caseRow = await seedCase(ds, { ...master, requesterId });

    await notifyCaseRegistered(ds, caseRow);

    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(0);
  });

  it('notifyCaseAssigned tells the assignee and the requester, with recipient-specific text', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });

    await notifyCaseAssigned(ds, caseRow);

    const [assignee] = await listNotificationsFor(ds, repId);
    const [requester] = await listNotificationsFor(ds, requesterId);
    expect(assignee.type).toBe('case.assigned');
    expect(assignee.body).toMatch(/assigned to you/i);
    expect(requester.type).toBe('case.assigned');
    expect(requester.body).toMatch(/assigned to a legal representative/i);
    expect(assignee.title).toContain(caseRow.referenceNumber);
  });

  it('notifyCaseAssigned sends one notification when the requester is also the assignee', async () => {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRow = await seedCase(ds, { ...master, requesterId: repId, status: 'Assigned', assignedLegalRepId: repId });

    await notifyCaseAssigned(ds, caseRow);

    const rows = await listNotificationsFor(ds, repId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/assigned to you/i);
  });

  it('notifyCaseAssigned tolerates a case with no assignee and still tells the requester', async () => {
    const { requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });

    await notifyCaseAssigned(ds, caseRow);

    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(1);
  });

  it('notifyCaseAccepted tells the requester only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    await notifyCaseAccepted(ds, caseRow);

    const rows = await listNotificationsFor(ds, requesterId);
    expect(rows.map((row) => row.type)).toEqual(['case.accepted']);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, managerId)).toHaveLength(0);
  });

  it('notifyAssignmentRejected tells every active legal manager, with the reason, and nobody else', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const managerA = await seedUserWithRole(ds, 'legal_manager');
    const managerB = await seedUserWithRole(ds, 'legal_manager');
    const inactiveManager = await seedUserWithRole(ds, 'legal_manager', { isActive: false });
    const adminId = await seedUserWithRole(ds, 'admin');

    await notifyAssignmentRejected(ds, caseRow, 'Conflict of interest with the counterparty');

    for (const managerId of [managerA, managerB]) {
      const rows = await listNotificationsFor(ds, managerId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('case.rejected');
      expect(rows[0].body).toContain('Conflict of interest with the counterparty');
      expect(rows[0].title).toContain(caseRow.referenceNumber);
    }
    for (const otherId of [inactiveManager, adminId, repId, requesterId]) {
      expect(await listNotificationsFor(ds, otherId)).toHaveLength(0);
    }
  });

  it('notifyAssignmentRejected with no legal manager at all creates nothing and does not throw', async () => {
    const { caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });

    await expect(notifyAssignmentRejected(ds, caseRow, 'x')).resolves.toBeUndefined();

    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications`);
    expect(count).toBe(0);
  });

  it('notifyCaseClosed tells the requester only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });

    await notifyCaseClosed(ds, caseRow);

    expect((await listNotificationsFor(ds, requesterId)).map((row) => row.type)).toEqual(['case.closed']);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });

  it('notifySlaBreached tells every active legal manager', async () => {
    const { caseRow } = await seedCaseWithParties(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const inactiveManager = await seedUserWithRole(ds, 'legal_manager', { isActive: false });

    await notifySlaBreached(ds, caseRow);

    expect((await listNotificationsFor(ds, managerId)).map((row) => row.type)).toEqual(['sla.breached']);
    expect(await listNotificationsFor(ds, inactiveManager)).toHaveLength(0);
  });

  it('activeLegalManagerIds returns only active users holding the legal_manager role', async () => {
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    await seedUserWithRole(ds, 'legal_manager', { isActive: false });
    await seedUserWithRole(ds, 'admin');
    await seedUserWithRole(ds, 'legal_rep');

    expect(await activeLegalManagerIds(ds)).toEqual([managerId]);
  });
});
