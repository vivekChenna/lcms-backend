import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadEnv } from '../../config/env';
import { REFRESH_COOKIE } from '../../config/security';
import { UnauthorizedError } from '../../shared/errors';
import { login, refreshSession, logout, changePassword, loadProfile } from './auth.service';
import { loginBodySchema, refreshBodySchema, sessionResponseSchema, changePasswordBodySchema, profileSchema } from './auth.schemas';
import { setSessionCookies, clearSessionCookies } from './auth-cookies';
import { loginRateLimit } from '../../plugins/rate-limit';

// The CSRF plugin skips its Origin check for any request carrying an
// Authorization header, so such a request must never be served from the cookie.
function refreshCookie(request: FastifyRequest): string | undefined {
  return request.headers.authorization === undefined ? request.cookies?.[REFRESH_COOKIE] : undefined;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/auth/login', {
    config: { rateLimit: loginRateLimit },
    schema: { tags: ['Auth'], body: loginBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request, reply) => {
    const { email, password } = request.body;
    const { user, refreshToken } = await login(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, email, password);
    const accessToken = app.signAccessToken(user);
    setSessionCookies(reply, app.security, accessToken, refreshToken);
    return { accessToken, refreshToken, user: await loadProfile(app.dataSource, user.id) };
  });

  typedApp.post('/auth/refresh', {
    schema: { tags: ['Auth'], body: refreshBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request, reply) => {
    const presented = request.body?.refreshToken ?? refreshCookie(request);
    if (!presented) {
      throw new UnauthorizedError('Missing refresh token');
    }
    const { user, refreshToken } = await refreshSession(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, presented);
    const accessToken = app.signAccessToken(user);
    setSessionCookies(reply, app.security, accessToken, refreshToken);
    return { accessToken, refreshToken, user: await loadProfile(app.dataSource, user.id) };
  });

  typedApp.post('/auth/logout', {
    schema: { tags: ['Auth'], body: refreshBodySchema },
  }, async (request, reply) => {
    const presented = request.body?.refreshToken ?? refreshCookie(request);
    if (presented) {
      await logout(app.dataSource, presented);
    }
    clearSessionCookies(reply, app.security);
    reply.status(204).send();
  });

  typedApp.get('/auth/me', {
    preHandler: [app.authenticate],
    schema: { tags: ['Auth'], security: [{ bearerAuth: [] }], response: { 200: profileSchema } },
  }, async (request) => loadProfile(app.dataSource, request.user.id));

  typedApp.post('/auth/change-password', {
    preHandler: [app.authenticate],
    schema: { tags: ['Auth'], security: [{ bearerAuth: [] }], body: changePasswordBodySchema },
  }, async (request, reply) => {
    await changePassword(app.dataSource, request.user.id, request.body.currentPassword, request.body.newPassword);
    reply.status(204).send();
  });
}
