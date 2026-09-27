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
  return function (request: FastifyRequest, _reply: FastifyReply): void {
    if (!allowed.includes(request.user.role)) {
      throw new ForbiddenError(`Role '${request.user.role}' is not permitted to perform this action`);
    }
  };
}
