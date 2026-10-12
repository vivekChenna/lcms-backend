import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadEnv } from '../../config/env';
import { requireRole } from '../../shared/rbac';
import { createUser, listUsers, getUserById, updateUserRole, deactivateUser, activateUser, updateUser, sendUserPasswordLink } from './users.service';
import { buildPaginatedResponse } from '../../shared/pagination';
import {
  createUserBodySchema,
  userResponseSchema,
  userListQuerySchema,
  userListResponseSchema,
  userIdParamsSchema,
  updateUserRoleBodySchema,
  updateUserBodySchema,
  createUserResponseSchema,
  sendPasswordLinkResponseSchema,
} from './users.schemas';

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/users', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], body: createUserBodySchema, response: { 201: createUserResponseSchema } },
  }, async (request, reply) => {
    const user = await createUser({ dataSource: app.dataSource, mailer: app.mailer, frontendUrl: app.frontendUrl, authStrategy: env.AUTH_STRATEGY }, request.user.id, request.body);
    reply.status(201).send(user);
  });

  typedApp.get('/users', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], querystring: userListQuerySchema, response: { 200: userListResponseSchema } },
  }, async (request) => {
    const { items, total } = await listUsers(app.dataSource, request.query);
    return buildPaginatedResponse(items, total, request.query);
  });

  typedApp.get('/users/:id', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], params: userIdParamsSchema, response: { 200: userResponseSchema } },
  }, async (request) => {
    return getUserById(app.dataSource, request.params.id);
  });

  typedApp.patch('/users/:id/role', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], params: userIdParamsSchema, body: updateUserRoleBodySchema, response: { 200: userResponseSchema } },
  }, async (request) => {
    return updateUserRole(app.dataSource, request.user.id, request.params.id, request.body.role);
  });

  typedApp.patch('/users/:id/deactivate', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], params: userIdParamsSchema, response: { 200: userResponseSchema } },
  }, async (request) => {
    return deactivateUser(app.dataSource, request.user.id, request.params.id);
  });

  typedApp.patch('/users/:id/activate', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], params: userIdParamsSchema, response: { 200: userResponseSchema } },
  }, async (request) => {
    return activateUser(app.dataSource, request.user.id, request.params.id);
  });

  typedApp.patch('/users/:id', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], params: userIdParamsSchema, body: updateUserBodySchema, response: { 200: userResponseSchema } },
  }, async (request) => {
    return updateUser(app.dataSource, request.user.id, request.params.id, request.body);
  });

  typedApp.post('/users/:id/send-password-link', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: ['Users'], security: [{ bearerAuth: [] }], params: userIdParamsSchema, response: { 200: sendPasswordLinkResponseSchema } },
  }, async (request) => {
    await sendUserPasswordLink({ dataSource: app.dataSource, mailer: app.mailer, frontendUrl: app.frontendUrl, authStrategy: env.AUTH_STRATEGY }, request.user.id, request.params.id);
    return { emailSent: true as const };
  });
}
