import type { DataSource } from 'typeorm';
import { AppNotification } from './entities/notification.entity';
import { NotFoundError } from '../../shared/errors';
import { buildPaginatedResponse, paginationToSkipTake } from '../../shared/pagination';

export async function listNotifications(
  dataSource: DataSource,
  userId: string,
  query: { page: number; pageSize: number; isRead?: boolean },
) {
  const repo = dataSource.getRepository(AppNotification);
  const where = query.isRead === undefined ? { userId } : { userId, isRead: query.isRead };
  const { skip, take } = paginationToSkipTake(query);
  const [items, total] = await repo.findAndCount({ where, order: { createdAt: 'DESC', id: 'DESC' }, skip, take });
  // Independent of the isRead filter: this feeds the frontend's bell badge.
  const unreadCount = await repo.count({ where: { userId, isRead: false } });
  return { ...buildPaginatedResponse(items, total, query), unreadCount };
}

export async function markNotificationRead(dataSource: DataSource, userId: string, notificationId: string): Promise<AppNotification> {
  const repo = dataSource.getRepository(AppNotification);
  const notification = await repo.findOne({ where: { id: notificationId, userId } });
  if (!notification) {
    throw new NotFoundError('Notification not found');
  }
  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date();
    await repo.save(notification);
  }
  return notification;
}
