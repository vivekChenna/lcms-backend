import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';

// global: false — this only decorates app.rateLimit()/the per-route `config.rateLimit`
// mechanism; it does not rate-limit every route by default. Every account is
// admin-created (no self-registration) and passwords are only 8+ characters,
// so /auth/login is the one route worth limiting explicitly (code review
// finding). hook: 'preHandler' runs this after body validation, so the
// login body is already parsed and typed when the keyGenerator reads it.
export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(fastifyRateLimit, { global: false });
});

export const loginRateLimit = {
  max: 5,
  timeWindow: '1 minute',
  hook: 'preHandler' as const,
  // Keyed by IP + the attempted email, not IP alone: an attacker spraying
  // one password across many accounts from one IP is slowed down per
  // target account, while many legitimate users behind the same
  // corporate NAT/IP don't rate-limit each other out.
  keyGenerator: (request: { ip: string; body?: unknown }): string => {
    const email = typeof request.body === 'object' && request.body !== null && 'email' in request.body
      ? String((request.body as { email: unknown }).email).toLowerCase()
      : '';
    return `${request.ip}:${email}`;
  },
};
