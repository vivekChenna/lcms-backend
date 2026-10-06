import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppNotification } from './entities/notification.entity';
import { loadCaseReferences } from '../../shared/name-lookup';
import { listNotifications, markNotificationRead } from './notifications.service';
import {
  notificationIdParamsSchema,
  notificationListResponseSchema,
  notificationListQuerySchema,
  notificationResponseSchema,
} from './notifications.schemas';

export function serializeNotification(row: AppNotification, references: Map<string, string>) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    relatedCaseId: row.relatedCaseId,
    relatedCaseReference: row.relatedCaseId ? (references.get(row.relatedCaseId) ?? null) : null,
    isRead: row.isRead,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export default async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/notifications', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Notifications'],
      security: [{ bearerAuth: [] }],
      querystring: notificationListQuerySchema,
      response: { 200: notificationListResponseSchema },
    },
  }, async (request) => {
    const result = await listNotifications(app.dataSource, request.user.id, request.query);
    const references = await loadCaseReferences(app.dataSource, result.items.map((item) => item.relatedCaseId));
    return { ...result, items: result.items.map((item) => serializeNotification(item, references)) };
  });

  typedApp.patch('/notifications/:id/read', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Notifications'],
      security: [{ bearerAuth: [] }],
      params: notificationIdParamsSchema,
      response: { 200: notificationResponseSchema },
    },
  }, async (request) => {
    const notification = await markNotificationRead(app.dataSource, request.user.id, request.params.id);
    const references = await loadCaseReferences(app.dataSource, [notification.relatedCaseId]);
    return serializeNotification(notification, references);
  });
}
