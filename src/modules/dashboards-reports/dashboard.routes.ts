import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getDashboard } from './dashboard.service';
import { dashboardResponseSchema } from './dashboard.schemas';

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/dashboard', {
    preHandler: [app.authenticate],
    schema: { tags: ['Dashboard'], security: [{ bearerAuth: [] }], response: { 200: dashboardResponseSchema } },
  }, async (request) =>
    getDashboard(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }));
}
