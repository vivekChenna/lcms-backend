import type { FastifyReply } from 'fastify';
import { ACCESS_COOKIE, REFRESH_COOKIE, type SecurityConfig } from '../../config/security';

function baseOptions(security: SecurityConfig) {
  return { httpOnly: true, secure: security.cookie.secure, sameSite: security.cookie.sameSite, domain: security.cookie.domain };
}

export function setSessionCookies(reply: FastifyReply, security: SecurityConfig, accessToken: string, refreshToken: string): void {
  reply.setCookie(ACCESS_COOKIE, accessToken, { ...baseOptions(security), path: '/', maxAge: security.cookie.accessMaxAgeSeconds });
  reply.setCookie(REFRESH_COOKIE, refreshToken, { ...baseOptions(security), path: '/auth', maxAge: security.cookie.refreshMaxAgeSeconds });
}

export function clearSessionCookies(reply: FastifyReply, security: SecurityConfig): void {
  const base = baseOptions(security);
  reply.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: '/auth' });
}
