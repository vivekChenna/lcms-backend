import type { DataSource } from 'typeorm';
import { Case } from '../cases/entities/case.entity';
import { notifySlaBreached } from '../notifications/notifications.events';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_WORKER_INTERVAL_MS = 600_000;

export type SlaScanResult = { notified: number };

// Each overdue case is claimed in its own short transaction with FOR UPDATE
// SKIP LOCKED, and the manager notifications and the slaBreachNotifiedAt stamp
// commit together, so every breach is notified exactly once even with
// concurrent scanners. Eligibility and the stamp use the database clock
// (now()), never the Node clock.
export async function scanForSlaBreaches(
  dataSource: DataSource,
  options: { batchSize?: number } = {},
): Promise<SlaScanResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: SlaScanResult = { notified: 0 };

  for (let processed = 0; processed < batchSize; processed += 1) {
    const claimed = await dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Case);
      const row = await repo
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('c.status != :closed', { closed: 'Closed' })
        .andWhere('c."resolutionDueAt" < now()')
        .andWhere('c."slaBreachNotifiedAt" IS NULL')
        .orderBy('c."resolutionDueAt"', 'ASC')
        .limit(1)
        .getOne();
      if (!row) {
        return false;
      }
      await notifySlaBreached(manager, row);
      await repo.update(row.id, { slaBreachNotifiedAt: () => 'now()' });
      result.notified += 1;
      return true;
    });
    if (!claimed) {
      break;
    }
  }
  return result;
}

export type SlaBreachWorker = { stop(): Promise<void> };

// Periodically scans for breached cases. Never overlaps two runs in one process;
// a failing run is reported through onError and does not stop the worker.
// Started only by server.ts, never by buildApp.
export function startSlaBreachWorker(deps: {
  dataSource: DataSource;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): SlaBreachWorker {
  let running = false;
  let stopped = false;
  let current: Promise<unknown> = Promise.resolve();

  const timer = setInterval(() => {
    if (running || stopped) {
      return;
    }
    running = true;
    current = scanForSlaBreaches(deps.dataSource)
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
