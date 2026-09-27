import type { FastifyInstance, FastifyError } from 'fastify';
import { AppError } from '../shared/errors';

// TypeORM's QueryFailedError spreads the raw pg driver error's own properties
// (code, detail, constraint, table) onto itself — so a Postgres unique
// violation reaches here as a plain `code: '23505'` field, not a typed class.
function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }

    if (isPostgresUniqueViolation(error)) {
      reply.status(409).send({
        error: { code: 'CONFLICT', message: 'A record with these values already exists' },
      });
      return;
    }

    if (error.validation) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.validation },
      });
      return;
    }

    // Any other error Fastify itself attaches a client-facing statusCode to
    // (malformed JSON body, oversized payload, unsupported content-type,
    // etc.) — pass its status through instead of masking it as a 500.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
      });
      return;
    }

    app.log.error(error);
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
}
