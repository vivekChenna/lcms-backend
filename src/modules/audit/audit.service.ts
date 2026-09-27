import type { DataSource } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export async function logAuditEvent(
  dataSource: DataSource,
  entry: {
    actorId: string;
    action: string;
    caseId?: string | null;
    beforeValue?: unknown;
    afterValue?: unknown;
  },
): Promise<void> {
  const repo = dataSource.getRepository(AuditLog);
  await repo.save(
    repo.create({
      actorId: entry.actorId,
      action: entry.action,
      caseId: entry.caseId ?? null,
      beforeValue: (entry.beforeValue ?? null) as Record<string, unknown> | null,
      afterValue: (entry.afterValue ?? null) as Record<string, unknown> | null,
    }),
  );
}
