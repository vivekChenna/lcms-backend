import Fastify, { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerErrorHandler } from './plugins/error-handler';
import swaggerPlugin from './plugins/swagger';
import rateLimitPlugin from './plugins/rate-limit';
import authPlugin from './plugins/auth';
import authRoutes from './modules/auth/auth.routes';
import auditRoutes from './modules/audit/audit.routes';
import usersRoutes from './modules/users/users.routes';
import masterDataRoutes from './modules/master-data/master-data.routes';
import casesRoutes from './modules/cases/cases.routes';

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
  app.register(swaggerPlugin);
  app.register(rateLimitPlugin);
  app.register(authPlugin);
  app.register(authRoutes);
  app.register(auditRoutes);
  app.register(usersRoutes);
  app.register(masterDataRoutes);
  app.register(casesRoutes);

  // Registered via .register() (rather than app.get(...) directly) so it boots
  // through the same avvio sequence as the other route modules, after
  // swaggerPlugin's onRoute hook is attached — a route added directly on the
  // parent instance is added to the router before that hook exists and is
  // silently missing from the generated OpenAPI spec.
  app.register(async (instance) => {
    instance.get('/health', { schema: { tags: ['Health'] } }, async () => ({ status: 'ok' }));
  });

  return app;
}
