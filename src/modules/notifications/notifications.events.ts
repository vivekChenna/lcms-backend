// src/modules/notifications/notifications.events.ts
import { In, type DataSource, type EntityManager } from 'typeorm';
import { AppNotification } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role } from '../users/entities/role.entity';
import type { Case } from '../cases/entities/case.entity';

export type NotificationSource = DataSource | EntityManager;
export type CaseRef = Pick<Case, 'id' | 'referenceNumber' | 'title' | 'requesterId' | 'assignedLegalRepId'>;

type Draft = { userId: string | null | undefined; title: string; body: string };

const MAX_TITLE_LENGTH = 200;

// The title doubles as the email subject, so it must never span lines.
export function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

export async function activeLegalManagerIds(source: NotificationSource): Promise<string[]> {
  const users = await source
    .getRepository(User)
    .createQueryBuilder('u')
    .innerJoin(UserRole, 'ur', 'ur."userId" = u.id')
    .innerJoin(Role, 'role', 'role.id = ur."roleId"')
    .where('role.name = :roleName', { roleName: 'legal_manager' })
    .andWhere('u."isActive" = true')
    .orderBy('u."createdAt"', 'ASC')
    .getMany();
  return users.map((user) => user.id);
}

async function activeUserIds(source: NotificationSource, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const users = await source.getRepository(User).find({ where: { id: In(ids), isActive: true } });
  return new Set(users.map((user) => user.id));
}

// Drafts are taken in order; a user already seen is skipped (first match wins),
// a missing or inactive recipient is skipped silently.
export async function createNotifications(
  source: NotificationSource,
  type: string,
  relatedCaseId: string,
  drafts: Draft[],
): Promise<void> {
  const seen = new Set<string>();
  const unique: Array<Draft & { userId: string }> = [];
  for (const draft of drafts) {
    if (!draft.userId || seen.has(draft.userId)) {
      continue;
    }
    seen.add(draft.userId);
    unique.push({ ...draft, userId: draft.userId });
  }
  const active = await activeUserIds(source, unique.map((draft) => draft.userId));
  const repo = source.getRepository(AppNotification);
  const rows = unique
    .filter((draft) => active.has(draft.userId))
    .map((draft) =>
      repo.create({
        userId: draft.userId,
        type,
        title: toSingleLine(draft.title),
        body: draft.body,
        relatedCaseId,
        isRead: false,
        readAt: null,
      }),
    );
  if (rows.length > 0) {
    await repo.save(rows);
  }
}

export async function createManagerNotifications(
  source: NotificationSource,
  type: string,
  caseRow: CaseRef,
  title: string,
  body: string,
): Promise<void> {
  const managerIds = await activeLegalManagerIds(source);
  await createNotifications(source, type, caseRow.id, managerIds.map((userId) => ({ userId, title, body })));
}

export async function notifyCaseRegistered(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.registered', caseRow.id, [
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} registered`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been registered.`,
    },
  ]);
}

export async function notifyCaseAssigned(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.assigned', caseRow.id, [
    {
      userId: caseRow.assignedLegalRepId,
      title: `Case ${caseRow.referenceNumber} assigned to you`,
      body: `Case "${caseRow.title}" (${caseRow.referenceNumber}) has been assigned to you. Please accept or reject it.`,
    },
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} assigned`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been assigned to a legal representative.`,
    },
  ]);
}

export async function notifyCaseAccepted(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.accepted', caseRow.id, [
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} accepted`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been accepted and is now in progress.`,
    },
  ]);
}

export async function notifyAssignmentRejected(source: NotificationSource, caseRow: CaseRef, reason: string): Promise<void> {
  await createManagerNotifications(
    source,
    'case.rejected',
    caseRow,
    `Assignment rejected for case ${caseRow.referenceNumber}`,
    `The assignment of case "${caseRow.title}" (${caseRow.referenceNumber}) was rejected and the case needs reassignment. Reason: ${reason}`,
  );
}

export async function notifyCaseClosed(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.closed', caseRow.id, [
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} closed`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been resolved and closed.`,
    },
  ]);
}

export async function notifySlaBreached(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createManagerNotifications(
    source,
    'sla.breached',
    caseRow,
    `SLA breached for case ${caseRow.referenceNumber}`,
    `Case "${caseRow.title}" (${caseRow.referenceNumber}) has passed its resolution due date.`,
  );
}
