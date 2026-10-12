import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadEnv } from '../../config/env';
import { REFRESH_COOKIE } from '../../config/security';
import { UnauthorizedError } from '../../shared/errors';
import { login, droneSignIn, refreshSession, logout, changePassword, loadProfile } from './auth.service';
import { loginBodySchema, dronaBodySchema, authConfigResponseSchema, refreshBodySchema, sessionResponseSchema, changePasswordBodySchema, profileSchema, forgotPasswordBodySchema, setPasswordBodySchema } from './auth.schemas';
import { ForbiddenError } from '../../shared/errors';
import { requestPasswordLink, setPasswordWithToken } from './password-links';
import { setSessionCookies, clearSessionCookies } from './auth-cookies';
import { loginRateLimit, setPasswordRateLimit } from '../../plugins/rate-limit';

// The CSRF plugin skips its Origin check for any request carrying an
// Authorization header, so such a request must never be served from the cookie.
function refreshCookie(request: FastifyRequest): string | undefined {
  return request.headers.authorization === undefined ? request.cookies?.[REFRESH_COOKIE] : undefined;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // Tells the frontend which sign-in screen to show, and lets it stay a client-side
  // choice without ever being the actual security boundary -- /auth/login itself
  // also refuses below while AUTH_STRATEGY=drona, so a direct call cannot bypass it.
  typedApp.get('/auth/config', {
    schema: { tags: ['Auth'], response: { 200: authConfigResponseSchema } },
  }, async () => ({
    mode: env.AUTH_STRATEGY,
    localLoginAllowed: env.AUTH_STRATEGY !== 'drona',
  }));

  typedApp.post('/auth/login', {
    config: { rateLimit: loginRateLimit },
    schema: { tags: ['Auth'], body: loginBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request, reply) => {
    if (env.AUTH_STRATEGY === 'drona') {
      throw new ForbiddenError('Password sign-in is turned off -- use the Drona sign-in instead.');
    }
    const { email, password } = request.body;
    const { user, refreshToken } = await login(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, email, password);
    const accessToken = app.signAccessToken(user);
    setSessionCookies(reply, app.security, accessToken, refreshToken);
    return { accessToken, refreshToken, user: await loadProfile(app.dataSource, user.id) };
  });

  // The DronaHQ container has already verified this person's identity; the email it
  // supplies is the only input. Still rate-limited like /auth/login -- an unlimited
  // endpoint that reveals "account exists / does not" via timing or status would be
  // a user-enumeration oracle regardless of there being no password to brute-force.
  typedApp.post('/auth/drona', {
    config: { rateLimit: loginRateLimit },
    schema: { tags: ['Auth'], body: dronaBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request, reply) => {
    const { user, refreshToken } = await droneSignIn(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, request.body.email);
    const accessToken = app.signAccessToken(user);
    setSessionCookies(reply, app.security, accessToken, refreshToken);
    return { accessToken, refreshToken, user: await loadProfile(app.dataSource, user.id) };
  });

  // Public. The answer is identical whether or not the address has an account, and the mail is sent
  // after the response, so neither the body nor the timing reveals who has one.
  typedApp.post('/auth/forgot-password', {
    config: { rateLimit: loginRateLimit },
    schema: { tags: ['Auth'], body: forgotPasswordBodySchema },
  }, async (request, reply) => {
    const deps = { dataSource: app.dataSource, mailer: app.mailer, frontendUrl: app.frontendUrl };
    void requestPasswordLink(deps, request.body.email).catch((error) => request.log.error(error, 'password link request failed'));
    reply.status(202).send({ message: 'If that account exists, we have emailed it a link.' });
  });

  // Public. The one-time token from the email is the credential.
  typedApp.post('/auth/set-password', {
    config: { rateLimit: setPasswordRateLimit },
    schema: { tags: ['Auth'], body: setPasswordBodySchema },
  }, async (request, reply) => {
    await setPasswordWithToken(app.dataSource, request.body.token, request.body.newPassword);
    reply.status(204).send();
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
