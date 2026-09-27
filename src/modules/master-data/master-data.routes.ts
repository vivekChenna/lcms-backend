import type { FastifyInstance } from 'fastify';
import { registerSimpleMasterDataResource } from './simple-resource';
import { Department } from './entities/department.entity';

export default async function masterDataRoutes(app: FastifyInstance): Promise<void> {
  registerSimpleMasterDataResource(app, { path: '/departments', entity: Department, auditPrefix: 'department' });
}
