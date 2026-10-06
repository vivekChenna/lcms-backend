import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../config/security';
import { CsrfBlockedError } from '../shared/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A browser attaches cookies to cross-site requests on its own, so a request
// authenticated only by our cookies must come from an allowed Origin. Requests
// with an Authorization header (not auto-attached by browsers) and requests that
// carry none of our cookies are unaffected. Must be registered after @fastify/cookie.
export default fp(async function csrfPlugin(app: FastifyInstance) {
  const allowed = new Set(app.security.corsOrigins);
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method) || request.headers.authorization) {
      return;
    }
    const cookies = request.cookies ?? {};
    if (!cookies[ACCESS_COOKIE] && !cookies[REFRESH_COOKIE]) {
      return;
    }
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin)) {
      throw new CsrfBlockedError('Cross-site request blocked');
    }
  });
});
