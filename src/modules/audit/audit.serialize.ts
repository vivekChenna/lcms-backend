import type { AuditLog } from './entities/audit-log.entity';
import { loadCaseReferences, loadUserNames, type NameSource } from '../../shared/name-lookup';

export async function serializeAuditRows(source: NameSource, rows: AuditLog[]) {
  const [users, references] = await Promise.all([
    loadUserNames(source, rows.map((row) => row.actorId)),
    loadCaseReferences(source, rows.map((row) => row.caseId)),
  ]);
  return rows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseReference: row.caseId ? (references.get(row.caseId) ?? null) : null,
    actorId: row.actorId,
    actorName: users.get(row.actorId)?.fullName ?? null,
    actorRole: users.get(row.actorId)?.role ?? null,
    action: row.action,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    createdAt: row.createdAt.toISOString(),
  }));
}

export type AuditRowResponse = Awaited<ReturnType<typeof serializeAuditRows>>[number];
