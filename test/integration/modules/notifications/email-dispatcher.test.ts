// test/integration/modules/notifications/email-dispatcher.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedNotification } from '../../helpers/seed-notification';
import { RecordingMailer } from '../../helpers/recording-mailer';
import { AppNotification } from '../../../../src/modules/notifications/entities/notification.entity';
import { dispatchPendingEmails } from '../../../../src/modules/notifications/email/email-dispatcher';

describe('dispatchPendingEmails', () => {
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

  const past = () => new Date(Date.now() - 3_600_000);
  const future = () => new Date(Date.now() + 3_600_000);
  const reload = (id: string) => ds.getRepository(AppNotification).findOneByOrFail({ id });

  async function recipient(email?: string, isActive = true) {
    const userId = await seedUserWithRole(ds, 'requester', { email, isActive });
    return userId;
  }

  it('sends a due pending notification to the user\'s address and marks it sent', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient('claimant@algihaz.local');
    const notification = await seedNotification(ds, { userId, title: 'Subject here', body: 'Body here', emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(mailer.sent).toEqual([{ to: 'claimant@algihaz.local', subject: 'Subject here', text: 'Body here' }]);
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('sent');
    expect(row.emailAttempts).toBe(1);
    expect(row.emailSentAt).toBeInstanceOf(Date);
    expect(row.emailLastError).toBeNull();
  });

  it('does not send a notification whose next attempt is in the future, nor sent or failed rows', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient();
    await seedNotification(ds, { userId, title: 'later', emailNextAttemptAt: future() });
    await seedNotification(ds, { userId, title: 'already sent', emailStatus: 'sent', emailNextAttemptAt: past() });
    await seedNotification(ds, { userId, title: 'given up', emailStatus: 'failed', emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(0);
  });

  it('on failure keeps the row pending, records the error, and schedules the retry about a minute out', async () => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('pending');
    expect(row.emailAttempts).toBe(1);
    expect(row.emailLastError).toBe('SMTP unavailable');
    const delayMs = row.emailNextAttemptAt.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(30_000);
    expect(delayMs).toBeLessThan(120_000);
  });

  it('does not retry before the backoff elapses, and recovers once the mail server does', async () => {
    const mailer = new RecordingMailer();
    mailer.failNext(1);
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailNextAttemptAt: past() });

    await dispatchPendingEmails(ds, mailer);
    const immediate = await dispatchPendingEmails(ds, mailer);

    expect(immediate).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(0);

    await ds.getRepository(AppNotification).update(notification.id, { emailNextAttemptAt: past() });
    const later = await dispatchPendingEmails(ds, mailer);

    expect(later.sent).toBe(1);
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('sent');
    expect(row.emailAttempts).toBe(2);
  });

  it.each([
    { priorAttempts: 0, expectedMinutes: 1 },
    { priorAttempts: 1, expectedMinutes: 5 },
    { priorAttempts: 2, expectedMinutes: 15 },
    { priorAttempts: 3, expectedMinutes: 60 },
  ])('after failure number $priorAttempts + 1 the retry is $expectedMinutes minutes out', async ({ priorAttempts, expectedMinutes }) => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailAttempts: priorAttempts, emailNextAttemptAt: past() });

    await dispatchPendingEmails(ds, mailer);

    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('pending');
    expect(row.emailAttempts).toBe(priorAttempts + 1);
    const delayMinutes = (row.emailNextAttemptAt.getTime() - Date.now()) / 60_000;
    expect(delayMinutes).toBeGreaterThan(expectedMinutes - 0.75);
    expect(delayMinutes).toBeLessThan(expectedMinutes + 0.75);
  });

  it('marks the notification failed after the 5th failed attempt and stops retrying', async () => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailAttempts: 4, emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('failed');
    expect(row.emailAttempts).toBe(5);
    expect(row.emailLastError).toBe('SMTP unavailable');
    expect((await dispatchPendingEmails(ds, mailer)).failed).toBe(0);
  });

  it('does not email a user who was deactivated after the notification was created, but keeps the in-app item', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient(undefined, false);
    const notification = await seedNotification(ds, { userId, emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(mailer.sent).toHaveLength(0);
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('failed');
    expect(row.emailLastError).toBe('recipient inactive');
    expect(row.isRead).toBe(false);
  });

  it('one failing send does not stop the other users\' emails, and never touches the in-app state', async () => {
    const mailer = new RecordingMailer();
    mailer.failNext(1);
    const first = await recipient('one@algihaz.local');
    const second = await recipient('two@algihaz.local');
    const a = await seedNotification(ds, { userId: first, title: 'first', createdAt: new Date(Date.now() - 2000), emailNextAttemptAt: past() });
    const b = await seedNotification(ds, { userId: second, title: 'second', createdAt: new Date(Date.now() - 1000), emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 1, retried: 1, failed: 0 });
    expect(mailer.sent.map((message) => message.to)).toEqual(['two@algihaz.local']);
    expect((await reload(a.id)).emailStatus).toBe('pending');
    expect((await reload(b.id)).emailStatus).toBe('sent');
    expect((await reload(a.id)).isRead).toBe(false);
  });

  it('honours the batch size', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient();
    for (let i = 0; i < 3; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: new Date(Date.now() - (3 - i) * 1000), emailNextAttemptAt: past() });
    }

    const result = await dispatchPendingEmails(ds, mailer, { batchSize: 2 });

    expect(result.sent).toBe(2);
    expect(mailer.sent.map((message) => message.subject)).toEqual(['n0', 'n1']);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE "emailStatus" = 'pending'`);
    expect(count).toBe(1);
  });

  it('two workers running at once send every email exactly once', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(40);
    const userId = await recipient();
    for (let i = 0; i < 4; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: new Date(Date.now() - (4 - i) * 1000), emailNextAttemptAt: past() });
    }

    const [a, b] = await Promise.all([dispatchPendingEmails(ds, mailer), dispatchPendingEmails(ds, mailer)]);

    expect(a.sent + b.sent).toBe(4);
    expect(mailer.sent.map((message) => message.subject).sort()).toEqual(['n0', 'n1', 'n2', 'n3']);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE "emailStatus" = 'sent'`);
    expect(count).toBe(4);
  });
});
