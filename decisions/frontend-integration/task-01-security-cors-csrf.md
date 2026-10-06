# Task 1 — Security configuration, CORS and CSRF protection

**Date:** 2026-10-09

**What:** Added `@fastify/cookie` and `@fastify/cors`, new env settings (`CORS_ORIGINS`, `COOKIE_SECURE`, `COOKIE_SAMESITE`, `COOKIE_DOMAIN`) and a `SecurityConfig` (`src/config/security.ts`) decorated on the app as `app.security`. CORS allows only the configured origins, with credentials, and exposes the CSV export headers. A CSRF plugin (`src/plugins/csrf.ts`) rejects non-safe requests that carry our auth cookies (`lcms_access` / `lcms_refresh`) unless the `Origin` header is an allowed origin (403 `CSRF_BLOCKED`).

**Why:** The React frontend runs on a different origin and will authenticate with httpOnly cookies. Browsers attach cookies to cross-site requests automatically, so cookie auth needs an Origin check. Requests with an `Authorization` header (not auto-attached) and requests with none of our cookies are not affected, so existing bearer-token clients keep working. Cookies are Secure by default only in production, and `SameSite=None` without Secure is refused at startup because browsers would drop the cookie. With no origins configured, CORS is off.

**Empty `CORS_ORIGINS`:** the CSRF check is unchanged, so with no origins configured every cookie-authenticated write (POST/PATCH/PUT/DELETE) is rejected with 403 `CSRF_BLOCKED`, even when the frontend is served from the same origin as the API. `CORS_ORIGINS` must list the frontend's own origin. The app logs a startup warning when the list is empty, and `.env.example` says the same.
