import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadEnv } from '../../config/env';
import { login, refreshSession, logout, changePassword } from './auth.service';
import { loginBodySchema, refreshBodySchema, sessionResponseSchema, changePasswordBodySchema } from './auth.schemas';
import { loginRateLimit } from '../../plugins/rate-limit';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/auth/login', {
    config: { rateLimit: loginRateLimit },
    schema: { tags: ['Auth'], body: loginBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request) => {
    const { email, password } = request.body;
    const { user, refreshToken } = await login(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, email, password);
    const accessToken = app.signAccessToken(user);
    return { accessToken, refreshToken, user };
  });

  typedApp.post('/auth/refresh', {
    schema: { tags: ['Auth'], body: refreshBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request) => {
    const { user, refreshToken } = await refreshSession(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, request.body.refreshToken);
    const accessToken = app.signAccessToken(user);
    return { accessToken, refreshToken, user };
  });

  typedApp.post('/auth/logout', {
    schema: { tags: ['Auth'], body: refreshBodySchema },
  }, async (request, reply) => {
    await logout(app.dataSource, request.body.refreshToken);
    reply.status(204).send();
  });

  typedApp.post('/auth/change-password', {
    preHandler: [app.authenticate],
    schema: { tags: ['Auth'], security: [{ bearerAuth: [] }], body: changePasswordBodySchema },
  }, async (request, reply) => {
    await changePassword(app.dataSource, request.user.id, request.body.currentPassword, request.body.newPassword);
    reply.status(204).send();
  });
}
