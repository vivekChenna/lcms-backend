import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerSimpleMasterDataResource } from './simple-resource';
import { requireRole } from '../../shared/rbac';
import { Department } from './entities/department.entity';
import { CaseCategory } from './entities/case-category.entity';
import { ClosureOutcome } from './entities/closure-outcome.entity';
import {
  listEntities, createEntity, updateEntity, listBusinessUnits, createBusinessUnit, updateBusinessUnit,
} from './org-structure.service';
import {
  entitySchema, createEntityBodySchema, updateEntityBodySchema,
  businessUnitSchema, createBusinessUnitBodySchema, updateBusinessUnitBodySchema, listBusinessUnitsQuerySchema,
  idParamsSchema,
} from './org-structure.schemas';
import { listCaseTypes, createCaseType, updateCaseType } from './case-types.service';
import { caseTypeSchema, createCaseTypeBodySchema, updateCaseTypeBodySchema, listCaseTypesQuerySchema } from './case-types.schemas';
import { listRoutingRules, createRoutingRule, updateRoutingRule } from './routing-rules.service';
import { routingRuleSchema, createRoutingRuleBodySchema, updateRoutingRuleBodySchema } from './routing-rules.schemas';

export default async function masterDataRoutes(app: FastifyInstance): Promise<void> {
  registerSimpleMasterDataResource(app, { path: '/departments', entity: Department, auditPrefix: 'department' });
  registerSimpleMasterDataResource(app, { path: '/case-categories', entity: CaseCategory, auditPrefix: 'case_category' });
  registerSimpleMasterDataResource(app, { path: '/closure-outcomes', entity: ClosureOutcome, auditPrefix: 'closure_outcome' });

  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/entities', {
    preHandler: [app.authenticate],
    schema: { response: { 200: z.array(entitySchema) } },
  }, async () => listEntities(app.dataSource));

  typedApp.post('/entities', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createEntityBodySchema, response: { 201: entitySchema } },
  }, async (request, reply) => {
    const entity = await createEntity(app.dataSource, request.user.id, request.body);
    reply.status(201).send(entity);
  });

  typedApp.patch('/entities/:id', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { params: idParamsSchema, body: updateEntityBodySchema, response: { 200: entitySchema } },
  }, async (request) => updateEntity(app.dataSource, request.user.id, request.params.id, request.body));

  typedApp.get('/business-units', {
    preHandler: [app.authenticate],
    schema: { querystring: listBusinessUnitsQuerySchema, response: { 200: z.array(businessUnitSchema) } },
  }, async (request) => listBusinessUnits(app.dataSource, request.query.entityId));

  typedApp.post('/business-units', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createBusinessUnitBodySchema, response: { 201: businessUnitSchema } },
  }, async (request, reply) => {
    const bu = await createBusinessUnit(app.dataSource, request.user.id, request.body);
    reply.status(201).send(bu);
  });

  typedApp.patch('/business-units/:id', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { params: idParamsSchema, body: updateBusinessUnitBodySchema, response: { 200: businessUnitSchema } },
  }, async (request) => updateBusinessUnit(app.dataSource, request.user.id, request.params.id, request.body));

  typedApp.get('/case-types', {
    preHandler: [app.authenticate],
    schema: { querystring: listCaseTypesQuerySchema, response: { 200: z.array(caseTypeSchema) } },
  }, async (request) => listCaseTypes(app.dataSource, request.query.categoryId));

  typedApp.post('/case-types', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createCaseTypeBodySchema, response: { 201: caseTypeSchema } },
  }, async (request, reply) => {
    const caseType = await createCaseType(app.dataSource, request.user.id, request.body);
    reply.status(201).send(caseType);
  });

  typedApp.patch('/case-types/:id', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { params: idParamsSchema, body: updateCaseTypeBodySchema, response: { 200: caseTypeSchema } },
  }, async (request) => updateCaseType(app.dataSource, request.user.id, request.params.id, request.body));

  typedApp.get('/routing-rules', {
    preHandler: [app.authenticate],
    schema: { response: { 200: z.array(routingRuleSchema) } },
  }, async () => listRoutingRules(app.dataSource));

  typedApp.post('/routing-rules', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createRoutingRuleBodySchema, response: { 201: routingRuleSchema } },
  }, async (request, reply) => {
    const rule = await createRoutingRule(app.dataSource, request.user.id, request.body);
    reply.status(201).send(rule);
  });

  typedApp.patch('/routing-rules/:id', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { params: idParamsSchema, body: updateRoutingRuleBodySchema, response: { 200: routingRuleSchema } },
  }, async (request) => updateRoutingRule(app.dataSource, request.user.id, request.params.id, request.body));
}
