import type { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { buildApp } from '../../../src/app';

export function buildTestApp(dataSource: DataSource): FastifyInstance {
  return buildApp(dataSource);
}
