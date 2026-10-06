import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedNotification, listNotificationsFor } from '../../helpers/seed-notification';

describe('notifications entity + migration', () => {
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

  it('round-trips a notification with the in-app and email defaults', async () => {
    const userId = await seedUserWithRole(ds, 'requester');
    const { caseRow } = await seedCaseWithParties(ds);

    const notification = await seedNotification(ds, { userId, relatedCaseId: caseRow.id, title: 'Hello', body: 'World' });

    expect(notification.id).toBeTruthy();
    expect(notification.isRead).toBe(false);
    expect(notification.readAt).toBeNull();
    expect(notification.emailStatus).toBe('pending');
    expect(notification.emailAttempts).toBe(0);
    expect(notification.emailSentAt).toBeNull();
    expect(notification.emailLastError).toBeNull();
    expect(notification.emailNextAttemptAt).toBeInstanceOf(Date);
    expect(notification.createdAt).toBeInstanceOf(Date);
  });

  it('allows a notification with no related case and lists a user\'s rows oldest first', async () => {
    const userId = await seedUserWithRole(ds, 'requester');
    const otherUserId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'older', createdAt: new Date(Date.now() - 60_000) });
    await seedNotification(ds, { userId, title: 'newer' });
    await seedNotification(ds, { userId: otherUserId, title: 'someone else' });

    const rows = await listNotificationsFor(ds, userId);

    expect(rows.map((row) => row.title)).toEqual(['older', 'newer']);
    expect(rows[0].relatedCaseId).toBeNull();
  });
});
