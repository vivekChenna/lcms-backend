import type { FastifyInstance } from 'fastify';
import { registerSimpleMasterDataResource } from './simple-resource';
import { Department } from './entities/department.entity';
import { CaseCategory } from './entities/case-category.entity';
import { ClosureOutcome } from './entities/closure-outcome.entity';

export default async function masterDataRoutes(app: FastifyInstance): Promise<void> {
  registerSimpleMasterDataResource(app, { path: '/departments', entity: Department, auditPrefix: 'department' });
  registerSimpleMasterDataResource(app, { path: '/case-categories', entity: CaseCategory, auditPrefix: 'case_category' });
  registerSimpleMasterDataResource(app, { path: '/closure-outcomes', entity: ClosureOutcome, auditPrefix: 'closure_outcome' });
}
