import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { createUser } from './users.service';
import { createUserBodySchema, userResponseSchema } from './users.schemas';

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/users', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createUserBodySchema, response: { 201: userResponseSchema } },
  }, async (request, reply) => {
    const user = await createUser(app.dataSource, request.user.id, request.body);
    reply.status(201).send(user);
  });
}
