import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CaseComment } from './entities/case-comment.entity';
import { createComment, listComments } from './comments.service';
import { commentListResponseSchema, commentResponseSchema, createCommentBodySchema } from './comments.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';

export function serializeComment(row: CaseComment) {
  return {
    id: row.id,
    caseId: row.caseId,
    authorId: row.authorId,
    body: row.body,
    isInternal: row.isInternal,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function commentsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/cases/:id/comments', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      response: { 200: commentListResponseSchema },
    },
  }, async (request) => {
    const rows = await listComments(app.dataSource, request.user, request.params.id);
    return rows.map(serializeComment);
  });

  typedApp.post('/cases/:id/comments', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: createCommentBodySchema,
      response: { 201: commentResponseSchema },
    },
  }, async (request, reply) => {
    const comment = await createComment(app.dataSource, request.user, request.params.id, request.body);
    reply.status(201).send(serializeComment(comment));
  });
}
