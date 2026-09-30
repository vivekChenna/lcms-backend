import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { EntityTarget, ObjectLiteral } from 'typeorm';
import { z } from 'zod';
import { requireRole } from '../../shared/rbac';
import { logAuditEvent } from '../audit/audit.service';
import { ConflictError, NotFoundError } from '../../shared/errors';

type SimpleResourceRow = { id: string; name: string; isActive: boolean };

export function registerSimpleMasterDataResource<T extends SimpleResourceRow & ObjectLiteral>(
  app: FastifyInstance,
  options: { path: string; entity: EntityTarget<T>; auditPrefix: string; tag: string },
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const itemSchema = z.object({ id: z.string(), name: z.string(), isActive: z.boolean() });
  const createBodySchema = z.object({ name: z.string().min(1) });
  const updateBodySchema = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional() });
  const idParamsSchema = z.object({ id: z.string().uuid() });

  typedApp.get(options.path, {
    preHandler: [app.authenticate],
    schema: { tags: [options.tag], security: [{ bearerAuth: [] }], response: { 200: z.array(itemSchema) } },
  }, async () => {
    return app.dataSource.getRepository(options.entity).find({ order: { name: 'ASC' } as never });
  });

  typedApp.post(options.path, {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: [options.tag], security: [{ bearerAuth: [] }], body: createBodySchema, response: { 201: itemSchema } },
  }, async (request, reply) => {
    const repo = app.dataSource.getRepository(options.entity);
    const existing = await repo.findOne({ where: { name: request.body.name } as never });
    if (existing) {
      throw new ConflictError(`'${request.body.name}' already exists`);
    }
    const row = await repo.save(repo.create({ name: request.body.name, isActive: true } as never) as unknown as T);
    await logAuditEvent(app.dataSource, { actorId: request.user.id, action: `${options.auditPrefix}.created`, afterValue: row });
    reply.status(201).send(row as z.infer<typeof itemSchema>);
  });

  typedApp.patch(`${options.path}/:id`, {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { tags: [options.tag], security: [{ bearerAuth: [] }], params: idParamsSchema, body: updateBodySchema, response: { 200: itemSchema } },
  }, async (request) => {
    const repo = app.dataSource.getRepository(options.entity);
    const row = await repo.findOne({ where: { id: request.params.id } as never });
    if (!row) {
      throw new NotFoundError('Not found');
    }
    const before = { id: row.id, name: row.name, isActive: row.isActive };
    if (request.body.name !== undefined) row.name = request.body.name;
    if (request.body.isActive !== undefined) row.isActive = request.body.isActive;
    await repo.save(row);
    await logAuditEvent(app.dataSource, {
      actorId: request.user.id,
      action: `${options.auditPrefix}.updated`,
      beforeValue: before,
      afterValue: { id: row.id, name: row.name, isActive: row.isActive },
    });
    return row;
  });
}
