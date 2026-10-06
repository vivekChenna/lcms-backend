import type { FastifyInstance } from 'fastify';
import type { DataSource, EntitySubscriberInterface } from 'typeorm';
import { AuditLog } from '../../../src/modules/audit/entities/audit-log.entity';
import { buildApp } from '../../../src/app';
import type { ObjectStorage } from '../../../src/shared/storage/object-storage';
import { DEFAULT_UPLOAD_CONFIG, type UploadConfig } from '../../../src/modules/documents/upload-config';
import type { SecurityConfig } from '../../../src/config/security';
import { InMemoryObjectStorage } from './in-memory-storage';
import { AUDITED_ROUTES, registerMutatingRoutes } from './audit-manifest';

const TEST_SECURITY: SecurityConfig = {
  corsOrigins: ['http://localhost:5173'],
  cookie: { secure: false, sameSite: 'lax', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2_592_000 },
};

const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

// One subscriber per DataSource counts every audit_log insert (all of them go
// through logAuditEvent's repository save).
const auditCounters = new WeakMap<DataSource, { count: number }>();
function auditInsertCounter(dataSource: DataSource): { count: number } {
  let counter = auditCounters.get(dataSource);
  if (!counter) {
    const created = { count: 0 };
    const subscriber: EntitySubscriberInterface<AuditLog> = {
      listenTo: () => AuditLog,
      afterInsert: () => { created.count += 1; },
    };
    dataSource.subscribers.push(subscriber);
    auditCounters.set(dataSource, created);
    counter = created;
  }
  return counter;
}

export function buildTestApp(
  dataSource: DataSource,
  options: {
    storage?: ObjectStorage;
    uploadConfig?: Partial<UploadConfig>;
    exportRowCap?: number;
    security?: Partial<SecurityConfig>;
    extraAuditedRoutes?: Record<string, string>;
    exemptRoutes?: string[];
  } = {},
): FastifyInstance {
  const app = buildApp(dataSource, {
    storage: options.storage ?? new InMemoryObjectStorage(),
    uploadConfig: { ...DEFAULT_UPLOAD_CONFIG, ...options.uploadConfig },
    exportRowCap: options.exportRowCap,
    security: { ...TEST_SECURITY, ...options.security, cookie: { ...TEST_SECURITY.cookie, ...options.security?.cookie } },
  });

  // Route modules load during ready(), so this onRoute hook sees every route.
  const mutating = new Set<string>();
  registerMutatingRoutes(app, mutating);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (MUTATING_METHODS.includes(method)) mutating.add(`${method} ${route.url}`);
    }
  });

  // Audit coverage runtime check: a 2xx on an audited route must have added an
  // audit_log row. A concurrent request can only hide a gap, never fake one.
  // The hooks are synchronous on purpose: many handlers call reply.send()
  // from an async handler without returning reply, and an async onSend hook
  // lets Fastify's wrap-thenable send a second, empty response meanwhile.
  // So rows are counted by a TypeORM subscriber, not by a SELECT COUNT(*).
  const auditRows = auditInsertCounter(dataSource);
  const audited = { ...AUDITED_ROUTES, ...options.extraAuditedRoutes };
  for (const key of options.exemptRoutes ?? []) delete audited[key];
  app.addHook('onRequest', (request, _reply, done) => {
    if (MUTATING_METHODS.includes(request.method)) {
      (request as unknown as { auditBefore?: number }).auditBefore = auditRows.count;
    }
    done();
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    const key = `${request.method} ${request.routeOptions?.url}`;
    const before = (request as unknown as { auditBefore?: number }).auditBefore;
    if (before === undefined || !(key in audited) || reply.statusCode < 200 || reply.statusCode >= 300 || auditRows.count > before) {
      done(null, payload);
      return;
    }
    reply.status(500).type('application/json');
    done(null, JSON.stringify({ error: { code: 'AUDIT_COVERAGE_MISSING', message: `Route ${key} succeeded without writing an audit entry` } }));
  });

  return app;
}
