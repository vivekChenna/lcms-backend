import Fastify, { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { runInRequestContext } from './db/request-context';
import { registerErrorHandler } from './plugins/error-handler';
import swaggerPlugin from './plugins/swagger';
import rateLimitPlugin from './plugins/rate-limit';
import authPlugin from './plugins/auth';
import csrfPlugin from './plugins/csrf';
import { securityConfigFromEnv, type SecurityConfig } from './config/security';
import { loadEnv } from './config/env';
import authRoutes from './modules/auth/auth.routes';
import auditRoutes from './modules/audit/audit.routes';
import usersRoutes from './modules/users/users.routes';
import masterDataRoutes from './modules/master-data/master-data.routes';
import casesRoutes from './modules/cases/cases.routes';
import informationRequestsRoutes from './modules/information-requests/information-requests.routes';
import commentsRoutes from './modules/comments/comments.routes';
import documentsRoutes from './modules/documents/documents.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import dashboardRoutes from './modules/dashboards-reports/dashboard.routes';
import reportsRoutes from './modules/dashboards-reports/reports.routes';
import type { ObjectStorage } from './shared/storage/object-storage';
import { DEFAULT_UPLOAD_CONFIG, type UploadConfig } from './modules/documents/upload-config';
import type { Mailer } from './modules/notifications/email/mailer';

declare module 'fastify' {
  interface FastifyInstance {
    dataSource: DataSource;
    security: SecurityConfig;
    /** null when email is not configured */
    mailer: Mailer | null;
    /** public frontend address used in emailed links; undefined when not configured */
    frontendUrl: string | undefined;
  }
}

export type AppOptions = {
  storage: ObjectStorage;
  uploadConfig?: UploadConfig;
  exportRowCap?: number;
  security?: SecurityConfig;
  mailer?: Mailer | null;
  frontendUrl?: string;
};

export function buildApp(dataSource: DataSource, options: AppOptions): FastifyInstance {
  const uploadConfig = options.uploadConfig ?? DEFAULT_UPLOAD_CONFIG;
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  app.decorate('dataSource', dataSource);
  const security = options.security ?? securityConfigFromEnv(loadEnv());
  app.decorate('security', security);
  app.decorate('mailer', options.mailer ?? null);
  app.decorate('frontendUrl', options.frontendUrl);
  // Every request gets its own database context (BRD AC-03, see src/db/request-context.ts). The user is
  // filled in by the authentication step; until then, and on public routes, the request sees nothing in
  // the row-level-secured tables.
  app.addHook('onRequest', (_request, _reply, done) => runInRequestContext(done));
  if (security.corsOrigins.length === 0) {
    app.log.warn('CORS_ORIGINS is empty: cookie-authenticated writes (POST/PATCH/PUT/DELETE) will be rejected with 403 CSRF_BLOCKED until CORS_ORIGINS lists the frontend origin, even when the frontend is served from the same origin as the API.');
  }
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
  app.register(cookie);
  app.register(cors, {
    origin: security.corsOrigins.length > 0 ? security.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Disposition', 'X-Export-Total', 'X-Export-Truncated'],
  });
  app.register(csrfPlugin);
  app.register(swaggerPlugin);
  app.register(rateLimitPlugin);
  app.register(authPlugin);
  app.register(authRoutes);
  app.register(auditRoutes, { exportRowCap: options.exportRowCap });
  app.register(usersRoutes);
  app.register(masterDataRoutes);
  app.register(casesRoutes, { exportRowCap: options.exportRowCap });
  app.register(informationRequestsRoutes);
  app.register(commentsRoutes);
  app.register(documentsRoutes, { storage: options.storage, uploadConfig });
  app.register(notificationsRoutes);
  app.register(dashboardRoutes);
  app.register(reportsRoutes, { exportRowCap: options.exportRowCap });

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
