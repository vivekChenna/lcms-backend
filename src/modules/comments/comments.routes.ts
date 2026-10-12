import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CaseComment } from './entities/case-comment.entity';
import { createComment, deleteComment, editComment, listComments } from './comments.service';
import { commentIdParamsSchema, commentListResponseSchema, commentResponseSchema, createCommentBodySchema, editCommentBodySchema } from './comments.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';
import { loadUserNames, type UserName } from '../../shared/name-lookup';

export function serializeComment(row: CaseComment, names: Map<string, UserName>) {
  const author = names.get(row.authorId);
  return {
    id: row.id,
    caseId: row.caseId,
    authorId: row.authorId,
    authorName: author?.fullName ?? null,
    authorRole: author?.role ?? null,
    authorDesignation: author?.designation ?? null,
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
    const names = await loadUserNames(app.dataSource, rows.map((row) => row.authorId));
    return rows.map((row) => serializeComment(row, names));
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
    const names = await loadUserNames(app.dataSource, [comment.authorId]);
    reply.status(201).send(serializeComment(comment, names));
  });

  typedApp.patch('/comments/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: commentIdParamsSchema,
      body: editCommentBodySchema,
      response: { 200: commentResponseSchema },
    },
  }, async (request) => {
    const comment = await editComment(app.dataSource, request.user, request.params.id, request.body.body);
    const names = await loadUserNames(app.dataSource, [comment.authorId]);
    return serializeComment(comment, names);
  });

  typedApp.delete('/comments/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: commentIdParamsSchema,
    },
  }, async (request, reply) => {
    await deleteComment(app.dataSource, request.user, request.params.id);
    reply.status(204).send();
  });
}
