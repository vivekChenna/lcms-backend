// test/integration/modules/notifications/email-worker.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedNotification } from '../../helpers/seed-notification';
import { RecordingMailer } from '../../helpers/recording-mailer';
import { startEmailWorker } from '../../../../src/modules/notifications/email/email-dispatcher';
import type { Mailer } from '../../../../src/modules/notifications/email/mailer';

describe('startEmailWorker', () => {
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

  async function waitFor(condition: () => boolean, timeoutMs = 4000) {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('condition not met in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('sends pending emails on its own once started, and stops cleanly', async () => {
    const mailer = new RecordingMailer();
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'picked up by the worker', emailNextAttemptAt: past() });

    const worker = startEmailWorker({ dataSource: ds, mailer, intervalMs: 20 });
    await waitFor(() => mailer.sent.length === 1);
    await worker.stop();

    expect(mailer.sent[0].subject).toBe('picked up by the worker');
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE "emailStatus" = 'sent'`);
    expect(count).toBe(1);
  });

  it('never runs two dispatches at once, even with a slow mail server and a short interval', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(120);
    const userId = await seedUserWithRole(ds, 'requester');
    for (let i = 0; i < 3; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: new Date(Date.now() - (3 - i) * 1000), emailNextAttemptAt: past() });
    }

    const worker = startEmailWorker({ dataSource: ds, mailer, intervalMs: 10 });
    await waitFor(() => mailer.sent.length === 3, 6000);
    await worker.stop();

    expect(mailer.maxInFlight).toBe(1);
  });

  it('reports a dispatch error to onError and keeps running', async () => {
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, emailNextAttemptAt: past() });
    const errors: unknown[] = [];
    let calls = 0;
    const exploding: Mailer = {
      async send() {
        calls += 1;
        throw new Error('boom');
      },
    };
    // A mailer failure is handled inside dispatchPendingEmails (retry bookkeeping);
    // to exercise the worker's own error path, pass a data source whose transaction throws.
    const brokenDataSource = { transaction: async () => { throw new Error('database unavailable'); } } as unknown as DataSource;

    const worker = startEmailWorker({ dataSource: brokenDataSource, mailer: exploding, intervalMs: 15, onError: (error) => errors.push(error) });
    await waitFor(() => errors.length >= 2);
    await worker.stop();

    expect((errors[0] as Error).message).toBe('database unavailable');
    expect(calls).toBe(0);
  });

  it('stop() waits for the in-flight run and no further runs start afterwards', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(80);
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'first', createdAt: new Date(Date.now() - 2000), emailNextAttemptAt: past() });

    const worker = startEmailWorker({ dataSource: ds, mailer, intervalMs: 10 });
    await waitFor(() => mailer.sent.length === 1);
    await worker.stop();
    await seedNotification(ds, { userId, title: 'after stop', emailNextAttemptAt: past() });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mailer.sent.map((message) => message.subject)).toEqual(['first']);
  });
});
