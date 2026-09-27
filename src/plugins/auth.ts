import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadEnv } from '../config/env';
import { UnauthorizedError } from '../shared/errors';
import type { AuthenticatedUser } from '../shared/rbac';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    signAccessToken: (payload: AuthenticatedUser) => string;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  const env = loadEnv();

  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
  });

  app.decorate('signAccessToken', (payload: AuthenticatedUser): string => {
    return app.jwt.sign(payload);
  });

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const decoded = await request.jwtVerify<AuthenticatedUser>();
      request.user = decoded;
    } catch {
      throw new UnauthorizedError('Missing or invalid access token');
    }
  });
});
