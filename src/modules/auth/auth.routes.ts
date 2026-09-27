import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadEnv } from '../../config/env';
import { login, refreshSession, logout } from './auth.service';
import { loginBodySchema, refreshBodySchema, sessionResponseSchema } from './auth.schemas';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/auth/login', {
    schema: { body: loginBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request) => {
    const { email, password } = request.body;
    const { user, refreshToken } = await login(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, email, password);
    const accessToken = app.signAccessToken(user);
    return { accessToken, refreshToken, user };
  });

  typedApp.post('/auth/refresh', {
    schema: { body: refreshBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request) => {
    const { user, refreshToken } = await refreshSession(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, request.body.refreshToken);
    const accessToken = app.signAccessToken(user);
    return { accessToken, refreshToken, user };
  });

  typedApp.post('/auth/logout', {
    schema: { body: refreshBodySchema },
  }, async (request, reply) => {
    await logout(app.dataSource, request.body.refreshToken);
    reply.status(204).send();
  });
}
