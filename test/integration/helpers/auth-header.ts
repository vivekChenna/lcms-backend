import type { FastifyInstance } from 'fastify';

export function authHeader(app: FastifyInstance, userId: string, role: string): { authorization: string } {
  const token = app.signAccessToken({ id: userId, role, departmentId: null, entityId: null, businessUnitId: null });
  return { authorization: `Bearer ${token}` };
}
