import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { toCaseWithSla, SlaState } from './sla';
import type { Case } from './entities/case.entity';
import { assignCase } from './cases.workflow.service';
import { assignCaseBodySchema, caseIdParamsSchema, caseResponseSchema } from './cases.schemas';

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
}
