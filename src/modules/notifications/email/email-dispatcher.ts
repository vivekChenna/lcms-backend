// src/modules/notifications/email/email-dispatcher.ts
import type { DataSource } from 'typeorm';
import { AppNotification } from '../entities/notification.entity';
import { User } from '../../users/entities/user.entity';
import type { Mailer } from './mailer';

export const MAX_EMAIL_ATTEMPTS = 5;
// Delay before the next try after the 1st, 2nd, 3rd and 4th failed attempt.
export const RETRY_DELAYS_MINUTES = [1, 5, 15, 60];
const DEFAULT_BATCH_SIZE = 10;

export type DispatchResult = { sent: number; retried: number; failed: number };

// Each notification is claimed and processed in its own short transaction with
// FOR UPDATE SKIP LOCKED, so concurrent workers never pick the same row and a
// crash can duplicate at most the single email that was in flight
// (at-least-once delivery). Eligibility and backoff use the database clock
// (now()), never the Node clock, so host/container clock drift cannot matter.
export async function dispatchPendingEmails(
  dataSource: DataSource,
  mailer: Mailer,
  options: { batchSize?: number } = {},
): Promise<DispatchResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: DispatchResult = { sent: 0, retried: 0, failed: 0 };

  for (let processed = 0; processed < batchSize; processed += 1) {
    const claimed = await dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AppNotification);
      const row = await repo
        .createQueryBuilder('n')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('n."emailStatus" = :status', { status: 'pending' })
        .andWhere('n."emailNextAttemptAt" <= now()')
        .orderBy('n."createdAt"', 'ASC')
        .limit(1)
        .getOne();
      if (!row) {
        return false;
      }

      const user = await manager.getRepository(User).findOne({ where: { id: row.userId } });
      if (!user || !user.isActive) {
        await repo.update(row.id, { emailStatus: 'failed', emailLastError: 'recipient inactive' });
        result.failed += 1;
        return true;
      }

      try {
        await mailer.send({ to: user.email, subject: row.title, text: row.body });
        await repo.update(row.id, {
          emailStatus: 'sent',
          emailAttempts: row.emailAttempts + 1,
          emailSentAt: () => 'now()',
          emailLastError: null,
        });
        result.sent += 1;
      } catch (error) {
        const attempts = row.emailAttempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= MAX_EMAIL_ATTEMPTS) {
          await repo.update(row.id, { emailStatus: 'failed', emailAttempts: attempts, emailLastError: message });
          result.failed += 1;
        } else {
          const delayMinutes = RETRY_DELAYS_MINUTES[attempts - 1];
          await repo.update(row.id, {
            emailAttempts: attempts,
            emailLastError: message,
            emailNextAttemptAt: () => `now() + interval '${delayMinutes} minutes'`,
          });
          result.retried += 1;
        }
      }
      return true;
    });
    if (!claimed) {
      break;
    }
  }
  return result;
}

// src/modules/notifications/email/email-dispatcher.ts — append at the end of the file
const DEFAULT_WORKER_INTERVAL_MS = 10_000;

export type EmailWorker = { stop(): Promise<void> };

// Polls for due emails. Never overlaps two runs in one process; a failing run is
// reported through onError and does not stop the worker. Started only by
// server.ts, never by buildApp, so tests drive dispatchPendingEmails directly.
export function startEmailWorker(deps: {
  dataSource: DataSource;
  mailer: Mailer;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): EmailWorker {
  let running = false;
  let stopped = false;
  let current: Promise<unknown> = Promise.resolve();

  const timer = setInterval(() => {
    if (running || stopped) {
      return;
    }
    running = true;
    current = dispatchPendingEmails(deps.dataSource, deps.mailer)
      .catch((error) => deps.onError?.(error))
      .finally(() => {
        running = false;
      });
  }, deps.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}
