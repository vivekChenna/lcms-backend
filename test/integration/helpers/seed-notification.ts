import type { DataSource } from 'typeorm';
import { AppNotification, type EmailStatus } from '../../../src/modules/notifications/entities/notification.entity';

export async function seedNotification(
  ds: DataSource,
  overrides: {
    userId: string;
    type?: string;
    title?: string;
    body?: string;
    relatedCaseId?: string | null;
    isRead?: boolean;
    readAt?: Date | null;
    createdAt?: Date;
    emailStatus?: EmailStatus;
    emailAttempts?: number;
    emailNextAttemptAt?: Date;
    emailSentAt?: Date | null;
    emailLastError?: string | null;
  },
): Promise<AppNotification> {
  const repo = ds.getRepository(AppNotification);
  return repo.save(
    repo.create({
      userId: overrides.userId,
      type: overrides.type ?? 'case.registered',
      title: overrides.title ?? 'A notification',
      body: overrides.body ?? 'Notification body',
      relatedCaseId: overrides.relatedCaseId ?? null,
      isRead: overrides.isRead ?? false,
      readAt: overrides.readAt ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.emailStatus ? { emailStatus: overrides.emailStatus } : {}),
      ...(overrides.emailAttempts !== undefined ? { emailAttempts: overrides.emailAttempts } : {}),
      ...(overrides.emailNextAttemptAt ? { emailNextAttemptAt: overrides.emailNextAttemptAt } : {}),
      emailSentAt: overrides.emailSentAt ?? null,
      emailLastError: overrides.emailLastError ?? null,
    }),
  );
}

export async function listNotificationsFor(ds: DataSource, userId: string): Promise<AppNotification[]> {
  return ds.getRepository(AppNotification).find({ where: { userId }, order: { createdAt: 'ASC' } });
}
