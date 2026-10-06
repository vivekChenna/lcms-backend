import Fastify, { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import multipart from '@fastify/multipart';
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
import informationRequestsRoutes from './modules/information-requests/information-requests.routes';
import commentsRoutes from './modules/comments/comments.routes';
import documentsRoutes from './modules/documents/documents.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import type { ObjectStorage } from './shared/storage/object-storage';
import { DEFAULT_UPLOAD_CONFIG, type UploadConfig } from './modules/documents/upload-config';

declare module 'fastify' {
  interface FastifyInstance {
    dataSource: DataSource;
  }
}

export type AppOptions = { storage: ObjectStorage; uploadConfig?: UploadConfig };

export function buildApp(dataSource: DataSource, options: AppOptions): FastifyInstance {
  const uploadConfig = options.uploadConfig ?? DEFAULT_UPLOAD_CONFIG;
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  app.decorate('dataSource', dataSource);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  // fileSize is one byte above the configured max so the service's own
  // SizeLimiter (which counts bytes and returns the project's 413 error) trips
  // first; this is only the backstop that stops a runaway upload.
  // request.file() buffers every non-file field before the file part, so the
  // body may contain exactly one part: the file. parts: 1 rejects any extra part
  // (fields: 0 skips any field's data rather than buffering it; fieldSize and
  // headerPairs are small backstops). A request with extra parts gets 413.
  app.register(multipart, {
    limits: { fileSize: uploadConfig.maxBytes + 1, files: 1, fields: 0, parts: 1, fieldSize: 1024, headerPairs: 20 },
    defCharset: 'utf8',
  });
  app.register(swaggerPlugin);
  app.register(rateLimitPlugin);
  app.register(authPlugin);
  app.register(authRoutes);
  app.register(auditRoutes);
  app.register(usersRoutes);
  app.register(masterDataRoutes);
  app.register(casesRoutes);
  app.register(informationRequestsRoutes);
  app.register(commentsRoutes);
  app.register(documentsRoutes, { storage: options.storage, uploadConfig });
  app.register(notificationsRoutes);

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
