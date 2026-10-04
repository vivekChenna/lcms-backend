import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { toCaseWithSla, SlaState } from './sla';
import type { Case } from './entities/case.entity';
import { acceptAssignment, assignCase, closeCase, rejectAssignment, setEscalation } from './cases.workflow.service';
import { getCaseById, listCases, submitCase, updateCase, updatePriority } from './cases.service';
import {
  assignCaseBodySchema,
  caseIdParamsSchema,
  caseListQuerySchema,
  caseListResponseSchema,
  caseResponseSchema,
  closeCaseBodySchema,
  createCaseBodySchema,
  escalateCaseBodySchema,
  rejectAssignmentBodySchema,
  updateCaseBodySchema,
  updatePriorityBodySchema,
} from './cases.schemas';

// toCaseWithSla (Task 4) deliberately keeps returning Date instances for
// timestamp fields — its own unit test fixes that contract — while
// caseResponseSchema (Task 6) declares them as strings for the OpenAPI/JSON
// contract. Nothing before this task ever actually serialized a Case
// through fastify-type-provider-zod, so the mismatch was latent; it surfaces
// here as the first route to do so. Converting at the route boundary matches
// the existing convention (audit.routes.ts, users.service.ts both do the
// same Date -> ISO string conversion at their respective boundaries), and
// this helper is exported so Tasks 8-14 can reuse it instead of
// re-deriving the same conversion on every other case route added to this file.
export function serializeCase(caseRow: Case & { slaState: SlaState; caseAgeHours: number }) {
  return {
    ...caseRow,
    assignmentAcceptedAt: caseRow.assignmentAcceptedAt ? caseRow.assignmentAcceptedAt.toISOString() : null,
    ackDueAt: caseRow.ackDueAt.toISOString(),
    resolutionDueAt: caseRow.resolutionDueAt.toISOString(),
    closedAt: caseRow.closedAt ? caseRow.closedAt.toISOString() : null,
    createdAt: caseRow.createdAt.toISOString(),
    updatedAt: caseRow.updatedAt.toISOString(),
  };
}

export default async function casesRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/cases', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      querystring: caseListQuerySchema,
      response: { 200: caseListResponseSchema },
    },
  }, async (request) => {
    const result = await listCases(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }, request.query);
    return { ...result, items: result.items.map(serializeCase) };
  });

  typedApp.get('/cases/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await getCaseById(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }, request.params.id);
    return serializeCase(caseRow);
  });

  typedApp.patch('/cases/:id', {
    preHandler: [app.authenticate, requireRole(['requester', 'legal_rep', 'admin'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: updateCaseBodySchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await updateCase(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }, request.params.id, request.body);
    return serializeCase(toCaseWithSla(caseRow));
  });

  typedApp.post('/cases', {
    preHandler: [app.authenticate, requireRole(['requester', 'legal_rep', 'admin'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      body: createCaseBodySchema,
      response: { 201: caseResponseSchema },
    },
  }, async (request, reply) => {
    const caseRow = await submitCase(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }, request.body);
    reply.status(201).send(serializeCase(toCaseWithSla(caseRow)));
  });

  typedApp.patch('/cases/:id/assign', {
    preHandler: [app.authenticate, requireRole(['legal_manager', 'admin'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: assignCaseBodySchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await assignCase(app.dataSource, request.user.id, request.params.id, request.body.targetLegalRepId);
    return serializeCase(toCaseWithSla(caseRow));
  });

  typedApp.patch('/cases/:id/accept', {
    // Assignment (VC-07) and auto-routing can target a legal_manager, not
    // only a legal_rep; the role gate must admit both so a case assigned to
    // a legal_manager isn't permanently stuck in Assigned. The service-layer
    // ownership check (assignedLegalRepId === actorId) still restricts this
    // to whoever is actually assigned, regardless of role.
    preHandler: [app.authenticate, requireRole(['legal_rep', 'legal_manager'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await acceptAssignment(app.dataSource, request.user.id, request.params.id);
    return serializeCase(toCaseWithSla(caseRow));
  });

  typedApp.patch('/cases/:id/reject', {
    // See /cases/:id/accept above: a legal_manager can also be the assignee.
    preHandler: [app.authenticate, requireRole(['legal_rep', 'legal_manager'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: rejectAssignmentBodySchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await rejectAssignment(app.dataSource, request.user.id, request.params.id, request.body.reason);
    return serializeCase(toCaseWithSla(caseRow));
  });

  typedApp.patch('/cases/:id/escalate', {
    preHandler: [app.authenticate, requireRole(['legal_rep', 'legal_manager', 'admin'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: escalateCaseBodySchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await setEscalation(
      app.dataSource,
      { id: request.user.id, role: request.user.role },
      request.params.id,
      request.body.isEscalated,
      request.body.reason,
    );
    return serializeCase(toCaseWithSla(caseRow));
  });

  typedApp.patch('/cases/:id/close', {
    preHandler: [app.authenticate, requireRole(['legal_rep', 'legal_manager', 'admin'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: closeCaseBodySchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await closeCase(
      app.dataSource,
      { id: request.user.id, role: request.user.role },
      request.params.id,
      { closureSummary: request.body.closureSummary, closureOutcomeId: request.body.closureOutcomeId },
    );
    return serializeCase(toCaseWithSla(caseRow));
  });

  typedApp.patch('/cases/:id/priority', {
    preHandler: [app.authenticate, requireRole(['legal_manager', 'admin'])],
    schema: {
      tags: ['Cases'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: updatePriorityBodySchema,
      response: { 200: caseResponseSchema },
    },
  }, async (request) => {
    const caseRow = await updatePriority(app.dataSource, request.user.id, request.params.id, request.body.priority);
    return serializeCase(toCaseWithSla(caseRow));
  });
}
