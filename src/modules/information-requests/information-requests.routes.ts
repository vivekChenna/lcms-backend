import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import type { InformationRequest } from './entities/information-request.entity';
import { raiseInformationRequest } from './information-requests.service';
import {
  raiseInformationRequestBodySchema,
  informationRequestResponseSchema,
} from './information-requests.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';

// Same Date -> ISO-string boundary conversion case core's serializeCase does,
// for the same reason: fastify-type-provider-zod validates-then-serializes
// against informationRequestResponseSchema's z.string() timestamp fields, and
// does not implicitly coerce a Date. Exported so every other route in this
// file reuses it instead of re-deriving the conversion.
export function serializeInformationRequest(row: InformationRequest) {
  return {
    ...row,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function informationRequestsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/cases/:id/information-requests', {
    preHandler: [app.authenticate, requireRole(['legal_rep'])],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: raiseInformationRequestBodySchema,
      response: { 201: informationRequestResponseSchema },
    },
  }, async (request, reply) => {
    const infoRequest = await raiseInformationRequest(app.dataSource, request.user.id, request.params.id, request.body);
    reply.status(201).send(serializeInformationRequest(infoRequest));
  });
}
