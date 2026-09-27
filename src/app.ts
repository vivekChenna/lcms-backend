import Fastify, { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerErrorHandler } from './plugins/error-handler';

declare module 'fastify' {
  interface FastifyInstance {
    dataSource: DataSource;
  }
}

export function buildApp(dataSource: DataSource): FastifyInstance {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  app.decorate('dataSource', dataSource);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
