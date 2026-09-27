import type { FastifyRequest, FastifyReply } from 'fastify';
import { ForbiddenError } from './errors';

export type AuthenticatedUser = {
  id: string;
  role: string;
  departmentId: string | null;
  entityId: string | null;
  businessUnitId: string | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

export function requireRole(allowed: string[]) {
  // Must be async: Fastify 5 only recognizes a preHandler as complete when it
  // returns a Promise (or takes a `done` callback). A plain synchronous
  // function that returns normally never signals completion and the request
  // hangs forever; it only "works" by accident when the check throws, since
  // the error path short-circuits. See Task 16 ledger ruling.
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!allowed.includes(request.user.role)) {
      throw new ForbiddenError(`Role '${request.user.role}' is not permitted to perform this action`);
    }
  };
}
