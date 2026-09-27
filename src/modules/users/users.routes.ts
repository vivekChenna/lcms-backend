import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { createUser, listUsers, getUserById } from './users.service';
import { buildPaginatedResponse } from '../../shared/pagination';
import { createUserBodySchema, userResponseSchema, userListQuerySchema, userListResponseSchema, userIdParamsSchema } from './users.schemas';

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/users', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createUserBodySchema, response: { 201: userResponseSchema } },
  }, async (request, reply) => {
    const user = await createUser(app.dataSource, request.user.id, request.body);
    reply.status(201).send(user);
  });

  typedApp.get('/users', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { querystring: userListQuerySchema, response: { 200: userListResponseSchema } },
  }, async (request) => {
    const { items, total } = await listUsers(app.dataSource, request.query);
    return buildPaginatedResponse(items, total, request.query);
  });

  typedApp.get('/users/:id', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { params: userIdParamsSchema, response: { 200: userResponseSchema } },
  }, async (request) => {
    return getUserById(app.dataSource, request.params.id);
  });
}
