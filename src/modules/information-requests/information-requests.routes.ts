import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import type { InformationRequest } from './entities/information-request.entity';
import { raiseInformationRequest, respondToInformationRequest, reopenInformationRequest, listInformationRequestsForCase } from './information-requests.service';
import {
  raiseInformationRequestBodySchema,
  respondInformationRequestBodySchema,
  reopenInformationRequestBodySchema,
  informationRequestIdParamsSchema,
  informationRequestResponseSchema,
  informationRequestListResponseSchema,
} from './information-requests.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';
import { loadUserNames, type NameSource, type UserName } from '../../shared/name-lookup';

// Same Date -> ISO-string boundary conversion case core's serializeCase does,
// for the same reason: fastify-type-provider-zod validates-then-serializes
// against informationRequestResponseSchema's z.string() timestamp fields, and
// does not implicitly coerce a Date. Exported so every other route in this
// file reuses it instead of re-deriving the conversion.
export function serializeInformationRequest(row: InformationRequest, names: Map<string, UserName>) {
  return {
    ...row,
    raisedByName: names.get(row.raisedById)?.fullName ?? null,
    raisedByRole: names.get(row.raisedById)?.role ?? null,
    responderName: names.get(row.responderId)?.fullName ?? null,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function loadRequestNames(source: NameSource, rows: InformationRequest[]) {
  return loadUserNames(source, rows.flatMap((row) => [row.raisedById, row.responderId]));
}

export default async function informationRequestsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/cases/:id/information-requests', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      response: { 200: informationRequestListResponseSchema },
    },
  }, async (request) => {
    const rows = await listInformationRequestsForCase(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }, request.params.id);
    const names = await loadRequestNames(app.dataSource, rows);
    return rows.map((row) => serializeInformationRequest(row, names));
  });

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
    const names = await loadRequestNames(app.dataSource, [infoRequest]);
    reply.status(201).send(serializeInformationRequest(infoRequest, names));
  });

  typedApp.post('/information-requests/:id/respond', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: informationRequestIdParamsSchema,
      body: respondInformationRequestBodySchema,
      response: { 200: informationRequestResponseSchema },
    },
  }, async (request) => {
    const infoRequest = await respondToInformationRequest(app.dataSource, request.user.id, request.params.id, request.body.responseText);
    const names = await loadRequestNames(app.dataSource, [infoRequest]);
    return serializeInformationRequest(infoRequest, names);
  });

  typedApp.post('/information-requests/:id/reopen', {
    preHandler: [app.authenticate, requireRole(['legal_rep'])],
    schema: {
      tags: ['Information Requests'],
      security: [{ bearerAuth: [] }],
      params: informationRequestIdParamsSchema,
      body: reopenInformationRequestBodySchema,
      response: { 200: informationRequestResponseSchema },
    },
  }, async (request) => {
    const infoRequest = await reopenInformationRequest(app.dataSource, request.user.id, request.params.id, request.body.comment);
    const names = await loadRequestNames(app.dataSource, [infoRequest]);
    return serializeInformationRequest(infoRequest, names);
  });
}
