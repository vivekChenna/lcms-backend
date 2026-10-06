# Frontend Integration Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the API usable from the browser frontend: cookie authentication with CORS and CSRF protection, a profile endpoint, names on responses, extra intake fields with confidential-case visibility, the lawyer dashboard changes, a case-scoped audit endpoint with a date filter, "mark all read", and a test-only guard that catches endpoints that forget their audit entry.

**Architecture:** Cross-cutting pieces live in `src/config/security.ts` (settings), two Fastify plugins (`csrf`, plus `@fastify/cookie` / `@fastify/cors` registered in `buildApp`) and `src/shared/name-lookup.ts` (batched name lookups). Case visibility stays centralised in `applyCaseFilters` and `getCaseById` in `cases.service.ts`, so the confidential rule reaches the list, export, dashboard, reports and every case sub-resource through the existing choke points.

**Tech Stack:** Fastify 5, TypeORM, PostgreSQL, Zod 4 + fastify-type-provider-zod, `@fastify/cookie`, `@fastify/cors`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-frontend-integration-design.md`

## Global Constraints

- **Commit messages must NOT contain a `Co-Authored-By` trailer or any Claude/Anthropic attribution line.** The project owner has asked for this repeatedly. Write commit messages as plain text exactly as shown in each task's commit step. Verify with `git log -1 --format=%B | grep -c "Co-Authored"` (must print 0).
- Work on `main`, one commit per task (code + tests + decision files together). Do not push. Never stage `.archify/`, `CLAUDE.md`, `Algihaz-LCMS-Database-Schema.docx`, `Timesheet_Sep-Oct_Algihaz_Vivek.xlsx`, or `docs/frontend-reference/`.
- Schema changes only via committed migrations (never `synchronize`). Every integration file's `afterAll` calls `ds.undoLastMigration()`, so a new last migration's `down()` must be correct. The next free migration slot is `1700000014000`.
- Test files use `resetDatabase(ds)` per test and seed fixtures per test (never in `beforeAll`). Run vitest from PowerShell if Git Bash fails at collection. Redirect long output to a file and grep it; never `tail` it. Run `npx tsc --noEmit` at the end of every task.
- Decision files: `decisions/frontend-integration/task-NN-<slug>.md` (`# Task N — title`, `**Date:** 2026-10-09`, `**What:**`, `**Why:**`) plus one bullet per task at the top of a new `## frontend-integration (readiness for the React frontend)` section in `decisions.md` (create the section in Task 1, directly above `## dashboards-reports`). `decisions.md` is UTF-8; edit it without re-encoding it or changing the line endings of existing lines (write the edit with Node `Buffer` operations or the editor tool; **never put backticks inside a double-quoted shell string**, the shell will eat them).
- Any route returning a `Date` through a Zod `z.string()` schema converts at the route boundary (`.toISOString()`). Name fields are `string | null` in response schemas; a missing user or master-data row yields `null`, never an error.
- Every name lookup is **batched** (one query per kind of id for the whole response), never one query per row.
- Existing clients using `Authorization: Bearer` and the tokens in the login response body must keep working; `Authorization` takes precedence over cookies.
- Use the alias `c` for `cases` in QueryBuilder (never `case`). Raw SQL only as expression fragments inside QueryBuilder strings, as the existing code does.
- Cookie names: `lcms_access` (path `/`) and `lcms_refresh` (path `/auth`). Both `HttpOnly`; `Secure`, `SameSite` and `Domain` come from configuration.
- Confidential case visibility (spec §5): a confidential case is hidden from **viewers** and from **requesters** who are neither the submitter (`requesterId`) nor the responder of an information request on it. Admin, legal manager and legal rep always see it. Hidden cases answer 404.
- TDD: write the failing test first, run it, see it fail, then implement.

## Review Focus

- A cookie-authenticated mutating request from a foreign or missing `Origin` must never succeed; requests with an `Authorization` header, requests without our cookies, and GET/HEAD/OPTIONS must never be blocked by the CSRF rule. Pinned in Task 1.
- Authorization header wins over the cookie, and a malformed Authorization header must not fall back to the cookie. Pinned in Task 2.
- A viewer or an unrelated requester must never learn that a confidential case exists: not through a list row, count, report figure, export row, search result, comment/document/information-request listing, or case audit entry. Pinned in Tasks 6, 7 and 8.
- The case audit endpoint must not reveal internal legal notes or the rejection reason to requesters or viewers. Pinned in Task 8.
- Names come from batched lookups and tolerate missing users. Pinned in Tasks 3 and 4.
- Every mutating route is classified in the audit manifest and the whole existing suite passes with the runtime check on. Pinned in Task 10.

---

### Task 1: Security configuration, CORS and CSRF protection

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add @fastify/cookie @fastify/cors`)
- Modify: `src/config/env.ts`
- Create: `src/config/security.ts`
- Modify: `src/shared/errors.ts` (add `CsrfBlockedError`)
- Create: `src/plugins/csrf.ts`
- Modify: `src/app.ts`
- Modify: `test/integration/helpers/build-test-app.ts`
- Modify: `.env.example`
- Test: `test/unit/config/security.test.ts`
- Test: `test/integration/security/cors-csrf.test.ts`

**Interfaces:**
- Produces:
  - `ACCESS_COOKIE = 'lcms_access'`, `REFRESH_COOKIE = 'lcms_refresh'`
  - `type SecurityConfig = { corsOrigins: string[]; cookie: { secure: boolean; sameSite: 'lax' | 'strict' | 'none'; domain?: string; accessMaxAgeSeconds: number; refreshMaxAgeSeconds: number } }`
  - `parseDurationSeconds(value: string): number` (supports `s|m|h|d`, e.g. `15m`)
  - `securityConfigFromEnv(env: Env): SecurityConfig`
  - `FastifyInstance.security: SecurityConfig` (decorated in `buildApp`)
  - `AppOptions.security?: SecurityConfig` (default `securityConfigFromEnv(loadEnv())`); `buildTestApp(ds, { security?: Partial<SecurityConfig> ... })` with the test default `corsOrigins: ['http://localhost:5173']`, cookie `{ secure: false, sameSite: 'lax', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2592000 }`
  - `CsrfBlockedError` (status 403, code `CSRF_BLOCKED`)

- [ ] **Step 1: Install the packages**

Run: `pnpm add @fastify/cookie @fastify/cors`
Expected: both appear under `dependencies`.

- [ ] **Step 2: Write the failing tests**

```typescript
// test/unit/config/security.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';
import { parseDurationSeconds, securityConfigFromEnv } from '../../../src/config/security';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('parseDurationSeconds', () => {
  it.each([['30s', 30], ['15m', 900], ['2h', 7200], ['30d', 2_592_000]])('parses %s', (input, seconds) => {
    expect(parseDurationSeconds(input as string)).toBe(seconds);
  });

  it('rejects unsupported formats', () => {
    expect(() => parseDurationSeconds('soon')).toThrow(/Unsupported duration/);
    expect(() => parseDurationSeconds('1h30m')).toThrow(/Unsupported duration/);
  });
});

describe('securityConfigFromEnv', () => {
  it('defaults to no CORS origins, lax non-secure cookies in development, token lifetimes from env', () => {
    const config = securityConfigFromEnv(loadEnv({ ...base, NODE_ENV: 'development' }));
    expect(config.corsOrigins).toEqual([]);
    expect(config.cookie).toMatchObject({ secure: false, sameSite: 'lax', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2_592_000 });
    expect(config.cookie.domain).toBeUndefined();
  });

  it('parses a comma separated origin list and trims blanks', () => {
    const config = securityConfigFromEnv(loadEnv({ ...base, CORS_ORIGINS: ' http://a.test , ,http://b.test ' }));
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('makes cookies secure by default in production and lets COOKIE_SECURE override', () => {
    expect(securityConfigFromEnv(loadEnv({ ...base, NODE_ENV: 'production' })).cookie.secure).toBe(true);
    expect(securityConfigFromEnv(loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).cookie.secure).toBe(false);
  });

  it('refuses SameSite=None without Secure', () => {
    expect(() => securityConfigFromEnv(loadEnv({ ...base, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' }))).toThrow(/requires COOKIE_SECURE/);
    expect(securityConfigFromEnv(loadEnv({ ...base, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'true' })).cookie.sameSite).toBe('none');
  });

  it('passes the cookie domain through', () => {
    expect(securityConfigFromEnv(loadEnv({ ...base, COOKIE_DOMAIN: '.algihaz.example' })).cookie.domain).toBe('.algihaz.example');
  });
});
```

```typescript
// test/integration/security/cors-csrf.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';
import { resetDatabase } from '../helpers/reset-db';
import { seedUserWithRole } from '../helpers/seed-user';
import { authHeader } from '../helpers/auth-header';

const ALLOWED = 'http://localhost:5173';
const FOREIGN = 'https://evil.example';

describe('CORS and CSRF protection', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  describe('CORS', () => {
    it('answers a preflight from an allowed origin with credentials allowed', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/cases',
        headers: { origin: ALLOWED, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type' },
      });

      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toMatch(/PATCH/);
      await app.close();
    });

    it('does not grant a foreign origin anything', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: FOREIGN } });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });

    it('exposes the CSV export headers to the allowed origin', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const viewerId = await seedUserWithRole(ds, 'viewer');

      const res = await app.inject({ method: 'GET', url: '/cases/export', headers: { ...authHeader(app, viewerId, 'viewer'), origin: ALLOWED } });

      const exposed = String(res.headers['access-control-expose-headers']).toLowerCase();
      expect(exposed).toContain('content-disposition');
      expect(exposed).toContain('x-export-total');
      expect(exposed).toContain('x-export-truncated');
      await app.close();
    });

    it('is off when no origins are configured', async () => {
      const app = buildTestApp(ds, { security: { corsOrigins: [] } });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: ALLOWED } });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });
  });

  describe('CSRF rule for cookie-authenticated mutations', () => {
    const cookie = { cookie: 'lcms_access=anything' };

    it('blocks a mutating request carrying our cookie with no Origin header', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: cookie, payload: {} });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_BLOCKED');
      await app.close();
    });

    it('blocks a mutating request carrying our cookie from a foreign origin', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { ...cookie, origin: FOREIGN }, payload: {} });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_BLOCKED');
      await app.close();
    });

    it('also guards the refresh cookie', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: 'lcms_refresh=anything', origin: FOREIGN }, payload: {} });

      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('lets a cookie request from an allowed origin through to the route', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { ...cookie, origin: ALLOWED }, payload: {} });

      expect(res.statusCode).not.toBe(403);
      await app.close();
    });

    it('never blocks safe methods', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health', headers: { ...cookie, origin: FOREIGN } });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('never blocks a request that carries an Authorization header', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const userId = await seedUserWithRole(ds, 'requester');

      const res = await app.inject({
        method: 'PATCH',
        url: '/notifications/read-all',
        headers: { ...authHeader(app, userId, 'requester'), ...cookie, origin: FOREIGN },
      });

      expect(res.statusCode).not.toBe(403);
      await app.close();
    });

    it('never blocks a mutating request that carries none of our cookies', async () => {
      const app = buildTestApp(ds);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: FOREIGN }, payload: { email: 'nobody@algihaz.local', password: 'x' } });

      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});
```

(`PATCH /notifications/read-all` does not exist until Task 9; in this task the Authorization-header test only needs the status to differ from 403, a 404 is fine.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config/security.test.ts test/integration/security/cors-csrf.test.ts`
Expected: FAIL — `Cannot find module '.../config/security'`.

- [ ] **Step 4: Implement**

`src/config/env.ts` — add to `envSchema`:

```typescript
  CORS_ORIGINS: z.string().default(''),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().min(1).optional(),
```

```typescript
// src/config/security.ts
import type { Env } from './env';

export const ACCESS_COOKIE = 'lcms_access';
export const REFRESH_COOKIE = 'lcms_refresh';

export type SecurityConfig = {
  corsOrigins: string[];
  cookie: {
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    domain?: string;
    accessMaxAgeSeconds: number;
    refreshMaxAgeSeconds: number;
  };
};

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration "${value}" (use a number and one unit, e.g. 15m, 2h, 30d)`);
  }
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
}

export function securityConfigFromEnv(env: Env): SecurityConfig {
  const secure = env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production';
  if (env.COOKIE_SAMESITE === 'none' && !secure) {
    throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  }
  return {
    corsOrigins: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    cookie: {
      secure,
      sameSite: env.COOKIE_SAMESITE,
      domain: env.COOKIE_DOMAIN,
      accessMaxAgeSeconds: parseDurationSeconds(env.JWT_ACCESS_EXPIRES_IN),
      refreshMaxAgeSeconds: env.REFRESH_TOKEN_EXPIRES_DAYS * 86_400,
    },
  };
}
```

```typescript
// src/shared/errors.ts — append
export class CsrfBlockedError extends AppError {
  readonly statusCode = 403;
  readonly code = 'CSRF_BLOCKED';
}
```

```typescript
// src/plugins/csrf.ts
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
```

`src/app.ts`:

```typescript
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import csrfPlugin from './plugins/csrf';
import { securityConfigFromEnv, type SecurityConfig } from './config/security';
import { loadEnv } from './config/env';

declare module 'fastify' {
  interface FastifyInstance {
    dataSource: DataSource;
    security: SecurityConfig;
  }
}

export type AppOptions = { storage: ObjectStorage; uploadConfig?: UploadConfig; exportRowCap?: number; security?: SecurityConfig };

// in buildApp, right after app.decorate('dataSource', dataSource):
  const security = options.security ?? securityConfigFromEnv(loadEnv());
  app.decorate('security', security);

// register, before swaggerPlugin / rateLimitPlugin / authPlugin:
  app.register(cookie);
  app.register(cors, {
    origin: security.corsOrigins.length > 0 ? security.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Disposition', 'X-Export-Total', 'X-Export-Truncated'],
  });
  app.register(csrfPlugin);
```

(Merge into the existing `declare module 'fastify'` block and `AppOptions` type instead of duplicating them.)

`test/integration/helpers/build-test-app.ts`:

```typescript
import type { SecurityConfig } from '../../../src/config/security';

const TEST_SECURITY: SecurityConfig = {
  corsOrigins: ['http://localhost:5173'],
  cookie: { secure: false, sameSite: 'lax', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2_592_000 },
};

// options gains:  security?: Partial<SecurityConfig>
// and buildApp(...) receives:  security: { ...TEST_SECURITY, ...options.security, cookie: { ...TEST_SECURITY.cookie, ...options.security?.cookie } }
```

`.env.example` — append:

```
# Browser access (CORS) and cookie settings for the frontend
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
# COOKIE_SECURE defaults to true only when NODE_ENV=production
# COOKIE_SECURE=false
COOKIE_SAMESITE=lax
# COOKIE_DOMAIN=.algihaz.example
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/unit/config/security.test.ts test/integration/security && npx tsc --noEmit`
Expected: PASS, `tsc` clean. Then prove nothing regressed: `npx vitest run test/integration/modules/auth test/integration/modules/cases` — expected PASS.

- [ ] **Step 6: Commit**

Create `decisions/frontend-integration/task-01-security-cors-csrf.md`; add the `## frontend-integration (readiness for the React frontend)` section and the first bullet to `decisions.md`.

```bash
git add package.json pnpm-lock.yaml src/config src/shared/errors.ts src/plugins/csrf.ts src/app.ts test/integration/helpers/build-test-app.ts .env.example test/unit/config/security.test.ts test/integration/security decisions.md decisions/frontend-integration/task-01-security-cors-csrf.md
git commit -m "feat: cookie and CORS configuration with CSRF origin check"
```

---

### Task 2: Cookie authentication and `GET /auth/me`

**Files:**
- Create: `src/modules/auth/auth-cookies.ts`
- Modify: `src/plugins/auth.ts` (token from header first, then cookie)
- Modify: `src/modules/auth/auth.service.ts` (`Profile`, `loadProfile`)
- Modify: `src/modules/auth/auth.schemas.ts` (profile schema, optional bodies)
- Modify: `src/modules/auth/auth.routes.ts`
- Modify: existing auth tests that no longer match (login/refresh/logout) — only as needed, never weakening
- Test: `test/integration/modules/auth/cookie-auth.test.ts`
- Test: `test/integration/modules/auth/me.test.ts`

**Interfaces:**
- Consumes: `ACCESS_COOKIE`, `REFRESH_COOKIE`, `SecurityConfig`, `app.security` (Task 1).
- Produces:
  - `setSessionCookies(reply, security: SecurityConfig, accessToken: string, refreshToken: string): void`, `clearSessionCookies(reply, security): void`
  - `type Profile = { id; fullName; email; designation: string | null; role: string; departmentId: string | null; departmentName: string | null; entityId: string | null; entityName: string | null; businessUnitId: string | null; businessUnitName: string | null }`; `loadProfile(dataSource, userId): Promise<Profile>`
  - `POST /auth/login` and `POST /auth/refresh` return `{ accessToken, refreshToken, user: Profile }` **and** set both cookies; `refresh` and `logout` accept an optional body `{ refreshToken? }` (absent body allowed) and fall back to the `lcms_refresh` cookie; `POST /auth/logout` always answers 204 and clears both cookies; `GET /auth/me` returns the `Profile`.
  - Frontend note: because `lcms-api.ts` sends `Content-Type: application/json`, body-less POSTs from the browser must send `{}`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/integration/modules/auth/cookie-auth.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';

const ORIGIN = 'http://localhost:5173';

function cookiesFrom(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const jar: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(';');
    const [name, ...value] = pair.split('=');
    jar[name.trim()] = value.join('=');
  }
  return jar;
}

function setCookieLine(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.find((line) => line.startsWith(`${name}=`)) ?? '';
}

describe('cookie authentication', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  async function loginAs(app: ReturnType<typeof buildTestApp>, email: string) {
    return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Password123!' } });
  }

  it('login sets both HttpOnly cookies with the configured attributes and still returns the tokens', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester', { email: 'cookie@algihaz.local' });

    const res = await loginAs(app, 'cookie@algihaz.local');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user.id).toBe(userId);
    const access = setCookieLine(res, 'lcms_access');
    const refresh = setCookieLine(res, 'lcms_refresh');
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Path=\//);
    expect(access).toMatch(/Max-Age=900/);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).not.toMatch(/Secure/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/auth/);
    expect(refresh).toMatch(/Max-Age=2592000/);
    await app.close();
  });

  it('marks cookies Secure and with the domain when configured', async () => {
    const app = buildTestApp(ds, { security: { cookie: { secure: true, sameSite: 'none', domain: '.algihaz.example', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2_592_000 } } });
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'secure@algihaz.local' });

    const res = await loginAs(app, 'secure@algihaz.local');

    const access = setCookieLine(res, 'lcms_access');
    expect(access).toMatch(/Secure/i);
    expect(access).toMatch(/SameSite=None/i);
    expect(access).toMatch(/Domain=\.algihaz\.example/i);
    await app.close();
  });

  it('authenticates a request from the access cookie alone', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'jar@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'jar@algihaz.local'));

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `lcms_access=${jar.lcms_access}` } });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('gives the Authorization header precedence and never falls back to the cookie when the header is malformed', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'a@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'a@algihaz.local'));

    const badHeader = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer not-a-token', cookie: `lcms_access=${jar.lcms_access}` } });
    const wrongScheme = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Basic abc', cookie: `lcms_access=${jar.lcms_access}` } });

    expect(badHeader.statusCode).toBe(401);
    expect(wrongScheme.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a missing or garbage access cookie with 401', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const none = await app.inject({ method: 'GET', url: '/auth/me' });
    const garbage = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: 'lcms_access=garbage' } });

    expect(none.statusCode).toBe(401);
    expect(garbage.statusCode).toBe(401);
    await app.close();
  });

  it('refresh works from the cookie, rotates the token and sets new cookies; replaying the old one fails', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'r@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'r@algihaz.local'));

    const first = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: `lcms_refresh=${jar.lcms_refresh}`, origin: ORIGIN }, payload: {} });
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: `lcms_refresh=${jar.lcms_refresh}`, origin: ORIGIN }, payload: {} });

    expect(first.statusCode).toBe(200);
    const next = cookiesFrom(first);
    expect(next.lcms_refresh).toBeTruthy();
    expect(next.lcms_refresh).not.toBe(jar.lcms_refresh);
    expect(next.lcms_access).toBeTruthy();
    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it('refresh still works with the token in the body (API clients) and answers 401 with no token at all', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'b@algihaz.local' });
    const login = (await loginAs(app, 'b@algihaz.local')).json();

    const viaBody = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: login.refreshToken } });
    const nothing = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} });

    expect(viaBody.statusCode).toBe(200);
    expect(nothing.statusCode).toBe(401);
    await app.close();
  });

  it('logout revokes the refresh token from the cookie and clears both cookies; it is idempotent without a token', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedUserWithRole(ds, 'requester', { email: 'l@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'l@algihaz.local'));

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `lcms_refresh=${jar.lcms_refresh}`, origin: ORIGIN }, payload: {} });
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: jar.lcms_refresh } });
    const again = await app.inject({ method: 'POST', url: '/auth/logout', payload: {} });

    expect(out.statusCode).toBe(204);
    expect(setCookieLine(out, 'lcms_access')).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
    expect(setCookieLine(out, 'lcms_refresh')).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
    expect(replay.statusCode).toBe(401);
    expect(again.statusCode).toBe(204);
    await app.close();
  });

  it('a deactivated user is cut off immediately even with a valid cookie', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester', { email: 'd@algihaz.local' });
    const jar = cookiesFrom(await loginAs(app, 'd@algihaz.local'));
    await ds.query(`UPDATE users SET "isActive" = false WHERE id = $1`, [userId]);

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `lcms_access=${jar.lcms_access}` } });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

```typescript
// test/integration/modules/auth/me.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('GET /auth/me and the login profile', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const nameOf = async (table: string, id: string) => (await ds.query(`SELECT name FROM ${table} WHERE id = $1`, [id]))[0].name as string;

  it('returns the full profile with organisation names for every role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    for (const role of ['admin', 'legal_manager', 'legal_rep', 'requester', 'viewer'] as const) {
      const userId = await seedUserWithRole(ds, role, { fullName: `Name ${role}`, departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
      await ds.query(`UPDATE users SET designation = $1 WHERE id = $2`, [`Designation ${role}`, userId]);

      const res = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader(app, userId, role) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: userId,
        fullName: `Name ${role}`,
        email: expect.stringContaining('@'),
        designation: `Designation ${role}`,
        role,
        departmentId: master.departmentId,
        departmentName: await nameOf('departments', master.departmentId),
        entityId: master.entityId,
        entityName: await nameOf('entities', master.entityId),
        businessUnitId: master.businessUnitId,
        businessUnitName: await nameOf('business_units', master.businessUnitId),
      });
    }
    await app.close();
  });

  it('uses nulls for an organisation the user has none of', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'viewer');

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader(app, userId, 'viewer') });

    expect(res.json()).toMatchObject({ designation: null, departmentId: null, departmentName: null, entityName: null, businessUnitName: null });
    await app.close();
  });

  it('login and refresh return the same profile shape in user', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const userId = await seedUserWithRole(ds, 'requester', { email: 'p@algihaz.local', fullName: 'Pat Profile', departmentId: master.departmentId, entityId: master.entityId });

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'p@algihaz.local', password: 'Password123!' } });
    const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: login.json().refreshToken } });

    for (const body of [login.json(), refresh.json()]) {
      expect(body.user).toMatchObject({ id: userId, fullName: 'Pat Profile', email: 'p@algihaz.local', role: 'requester', departmentName: await nameOf('departments', master.departmentId) });
    }
    await app.close();
  });

  it('requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/auth/me' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/integration/modules/auth/cookie-auth.test.ts test/integration/modules/auth/me.test.ts`
Expected: FAIL — no cookies are set, `/auth/me` is 404.

- [ ] **Step 3: Implement**

```typescript
// src/modules/auth/auth-cookies.ts
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
```

`src/plugins/auth.ts` — token extraction (header first; a present-but-malformed header never falls back to the cookie):

```typescript
import { ACCESS_COOKIE } from '../config/security';

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1] : undefined;
  }
  return request.cookies?.[ACCESS_COOKIE];
}

// in the fastifyJwt registration:
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
    verify: { extractToken },
  });
```

(If the installed `@fastify/jwt` version does not support `verify.extractToken`, call `request.jwtVerify({ extractToken })` or the equivalent supported option; the behaviour above is the requirement.)

`src/modules/auth/auth.service.ts` — add:

```typescript
import { Department } from '../master-data/entities/department.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';

export type Profile = {
  id: string; fullName: string; email: string; designation: string | null; role: string;
  departmentId: string | null; departmentName: string | null;
  entityId: string | null; entityName: string | null;
  businessUnitId: string | null; businessUnitName: string | null;
};

export async function loadProfile(dataSource: DataSource, userId: string): Promise<Profile> {
  const user = await dataSource.getRepository(User).findOneOrFail({ where: { id: userId } });
  const { role } = await loadAuthenticatedUser(dataSource, user);
  const [department, entity, businessUnit] = await Promise.all([
    user.departmentId ? dataSource.getRepository(Department).findOne({ where: { id: user.departmentId } }) : null,
    user.entityId ? dataSource.getRepository(OrgEntity).findOne({ where: { id: user.entityId } }) : null,
    user.businessUnitId ? dataSource.getRepository(BusinessUnit).findOne({ where: { id: user.businessUnitId } }) : null,
  ]);
  return {
    id: user.id, fullName: user.fullName, email: user.email, designation: user.designation, role,
    departmentId: user.departmentId, departmentName: department?.name ?? null,
    entityId: user.entityId, entityName: entity?.name ?? null,
    businessUnitId: user.businessUnitId, businessUnitName: businessUnit?.name ?? null,
  };
}
```

`src/modules/auth/auth.schemas.ts`:

```typescript
export const refreshBodySchema = z.object({ refreshToken: z.string().min(1).optional() }).optional();

export const profileSchema = z.object({
  id: z.string(), fullName: z.string(), email: z.string(), designation: z.string().nullable(), role: z.string(),
  departmentId: z.string().nullable(), departmentName: z.string().nullable(),
  entityId: z.string().nullable(), entityName: z.string().nullable(),
  businessUnitId: z.string().nullable(), businessUnitName: z.string().nullable(),
});

export const sessionResponseSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), user: profileSchema });
```

`src/modules/auth/auth.routes.ts` — replace the login/refresh/logout handlers and add `/auth/me`:

```typescript
import { REFRESH_COOKIE } from '../../config/security';
import { UnauthorizedError } from '../../shared/errors';
import { setSessionCookies, clearSessionCookies } from './auth-cookies';
import { loadProfile } from './auth.service';
import { profileSchema } from './auth.schemas';

  typedApp.post('/auth/login', { /* unchanged config + schema */ }, async (request, reply) => {
    const { email, password } = request.body;
    const { user, refreshToken } = await login(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, email, password);
    const accessToken = app.signAccessToken(user);
    setSessionCookies(reply, app.security, accessToken, refreshToken);
    return { accessToken, refreshToken, user: await loadProfile(app.dataSource, user.id) };
  });

  typedApp.post('/auth/refresh', {
    schema: { tags: ['Auth'], body: refreshBodySchema, response: { 200: sessionResponseSchema } },
  }, async (request, reply) => {
    const presented = request.body?.refreshToken ?? request.cookies?.[REFRESH_COOKIE];
    if (!presented) {
      throw new UnauthorizedError('Missing refresh token');
    }
    const { user, refreshToken } = await refreshSession(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, presented);
    const accessToken = app.signAccessToken(user);
    setSessionCookies(reply, app.security, accessToken, refreshToken);
    return { accessToken, refreshToken, user: await loadProfile(app.dataSource, user.id) };
  });

  typedApp.post('/auth/logout', { schema: { tags: ['Auth'], body: refreshBodySchema } }, async (request, reply) => {
    const presented = request.body?.refreshToken ?? request.cookies?.[REFRESH_COOKIE];
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
```

Update the existing auth tests (`login.test.ts`, `refresh.test.ts`, `logout.test.ts`) only where an old expectation is now different by design (for example a missing refresh token on `/auth/refresh` was 400 and is now 401; a missing body on logout was 400 and is now 204). List every changed expectation in your report; never weaken an assertion that is still meant to hold.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/auth test/integration/security && npx tsc --noEmit`
Expected: PASS, `tsc` clean. Then the regression run: `npx vitest run test/integration/modules/users test/integration/modules/cases`.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-02-cookie-auth-and-me.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/modules/auth src/plugins/auth.ts test/integration/modules/auth decisions.md decisions/frontend-integration/task-02-cookie-auth-and-me.md
git commit -m "feat: cookie authentication, optional refresh bodies and GET /auth/me"
```

---

### Task 3: Name lookup module and names on case responses

**Files:**
- Create: `src/shared/name-lookup.ts`
- Create: `src/modules/cases/case-names.ts`
- Modify: `src/modules/cases/cases.schemas.ts` (`caseResponseSchema` gains the name fields)
- Modify: `src/modules/cases/cases.routes.ts` (every route returning a case)
- Modify: `src/modules/cases/cases.export.ts` (name columns)
- Test: `test/integration/modules/cases/case-names.test.ts`
- Test: `test/unit/shared/name-lookup.test.ts` (optional small unit test if you prefer it to an integration one)

**Interfaces:**
- Produces:
  - `type UserName = { fullName: string; designation: string | null; role: string | null }`; `loadUserNames(source: DataSource | EntityManager, ids: Array<string | null | undefined>): Promise<Map<string, UserName>>`
  - `loadNamesById(source, entity: new () => { id: string; name: string }, ids): Promise<Map<string, string>>` (for `CaseCategory`, `CaseType`, `Department`, `OrgEntity`, `BusinessUnit`)
  - `loadCaseReferences(source, ids): Promise<Map<string, string>>` (case id → reference number)
  - `type CaseNameFields = { requesterName: string | null; requesterDesignation: string | null; assignedLegalRepName: string | null; assignedLegalRepRole: string | null; categoryName: string | null; caseTypeName: string | null; departmentName: string | null; entityName: string | null; businessUnitName: string | null }`
  - `withCaseNames<T extends Case>(source, rows: T[]): Promise<Array<T & CaseNameFields>>`
  - every case response (list, detail, create, update, assign, accept, reject, close, escalate, priority) and the case CSV export carry the `CaseNameFields`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/cases/case-names.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('names on case responses', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const nameOf = async (table: string, id: string) => (await ds.query(`SELECT name FROM ${table} WHERE id = $1`, [id]))[0].name as string;

  async function scenario() {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { fullName: 'Rana Requester', departmentId: master.departmentId, entityId: master.entityId });
    await ds.query(`UPDATE users SET designation = 'Procurement Specialist' WHERE id = $1`, [requesterId]);
    const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Lina Lawyer' });
    const managerId = await seedUserWithRole(ds, 'legal_manager', { fullName: 'Mona Manager' });
    const assigned = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId, referenceNumber: 'NAME-1' });
    const unassigned = await seedCase(ds, { ...master, requesterId, status: 'Submitted', businessUnitId: null, referenceNumber: 'NAME-2' });
    return { master, requesterId, repId, managerId, assigned, unassigned };
  }

  it('GET /cases/:id carries requester, assignee and master-data names', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: `/cases/${s.assigned.id}`, headers: authHeader(app, s.managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      requesterName: 'Rana Requester',
      requesterDesignation: 'Procurement Specialist',
      assignedLegalRepName: 'Lina Lawyer',
      assignedLegalRepRole: 'legal_rep',
      categoryName: await nameOf('case_categories', s.master.categoryId),
      caseTypeName: await nameOf('case_types', s.master.caseTypeId),
      departmentName: await nameOf('departments', s.master.departmentId),
      entityName: await nameOf('entities', s.master.entityId),
      businessUnitName: await nameOf('business_units', s.master.businessUnitId),
    });
    await app.close();
  });

  it('uses null for an unassigned case and a missing business unit', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: `/cases/${s.unassigned.id}`, headers: authHeader(app, s.managerId, 'legal_manager') });

    expect(res.json()).toMatchObject({ assignedLegalRepName: null, assignedLegalRepRole: null, businessUnitName: null });
    await app.close();
  });

  it('lets a requester see the assignee name (no unknown users)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers: authHeader(app, s.requesterId, 'requester') });

    const row = res.json().items.find((item: { referenceNumber: string }) => item.referenceNumber === 'NAME-1');
    expect(row.assignedLegalRepName).toBe('Lina Lawyer');
    await app.close();
  });

  it('every list row is named', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers: authHeader(app, s.managerId, 'legal_manager') });

    expect(res.json().items).toHaveLength(2);
    for (const item of res.json().items) {
      expect(item.requesterName).toBe('Rana Requester');
      expect(item.categoryName).toBeTruthy();
      expect(item.departmentName).toBeTruthy();
    }
    await app.close();
  });

  it('a case whose requester row no longer resolves gets null names instead of failing', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();
    await ds.query(`UPDATE users SET "fullName" = 'Rana Requester' WHERE id = $1`, [s.requesterId]);
    // simulate a lookup miss for the assignee by pointing the case at a user that is then deactivated is not a miss;
    // a true miss needs a deleted user, so assert the helper contract directly:
    const { loadUserNames } = await import('../../../../src/shared/name-lookup');

    const names = await loadUserNames(ds, ['00000000-0000-4000-8000-000000000000', null, undefined, s.requesterId]);

    expect(names.size).toBe(1);
    expect(names.get(s.requesterId)?.fullName).toBe('Rana Requester');
    await app.close();
  });

  it('workflow responses are named too (assign)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'PATCH', url: `/cases/${s.unassigned.id}/assign`, headers: authHeader(app, s.managerId, 'legal_manager'), payload: { targetLegalRepId: s.repId } });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignedLegalRepName).toBe('Lina Lawyer');
    expect(res.json().requesterName).toBe('Rana Requester');
    await app.close();
  });

  it('the CSV export gains name columns after the id columns', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const s = await scenario();

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, s.managerId, 'legal_manager') });

    const lines = res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('requesterName');
    expect(lines[0]).toContain('assignedLegalRepName');
    expect(lines[0]).toContain('departmentName');
    expect(res.body).toContain('Lina Lawyer');
    expect(res.body).toContain('Rana Requester');
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/cases/case-names.test.ts`
Expected: FAIL — name fields are undefined / `Cannot find module '.../shared/name-lookup'`.

- [ ] **Step 3: Implement**

```typescript
// src/shared/name-lookup.ts
import { In, type DataSource, type EntityManager } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';
import { Role } from '../modules/users/entities/role.entity';
import { Case } from '../modules/cases/entities/case.entity';

export type NameSource = DataSource | EntityManager;
export type UserName = { fullName: string; designation: string | null; role: string | null };
type MaybeId = string | null | undefined;

const unique = (ids: MaybeId[]): string[] => [...new Set(ids.filter((id): id is string => Boolean(id)))];

// One query for the whole set of ids. Ids that do not resolve are simply absent
// from the map, so callers fall back to null instead of failing.
export async function loadUserNames(source: NameSource, ids: MaybeId[]): Promise<Map<string, UserName>> {
  const list = unique(ids);
  const result = new Map<string, UserName>();
  if (list.length === 0) {
    return result;
  }
  const rows = await source
    .getRepository(User)
    .createQueryBuilder('u')
    .leftJoin(UserRole, 'ur', 'ur."userId" = u.id')
    .leftJoin(Role, 'role', 'role.id = ur."roleId"')
    .select('u.id', 'id')
    .addSelect('u."fullName"', 'fullName')
    .addSelect('u.designation', 'designation')
    .addSelect('role.name', 'role')
    .where('u.id IN (:...ids)', { ids: list })
    .getRawMany<{ id: string; fullName: string; designation: string | null; role: string | null }>();
  for (const row of rows) {
    result.set(row.id, { fullName: row.fullName, designation: row.designation, role: row.role });
  }
  return result;
}

export async function loadNamesById(
  source: NameSource,
  entity: new () => { id: string; name: string },
  ids: MaybeId[],
): Promise<Map<string, string>> {
  const list = unique(ids);
  const result = new Map<string, string>();
  if (list.length === 0) {
    return result;
  }
  const rows = await source.getRepository(entity).find({ where: { id: In(list) } as never });
  for (const row of rows) {
    result.set(row.id, row.name);
  }
  return result;
}

export async function loadCaseReferences(source: NameSource, ids: MaybeId[]): Promise<Map<string, string>> {
  const list = unique(ids);
  const result = new Map<string, string>();
  if (list.length === 0) {
    return result;
  }
  const rows = await source.getRepository(Case).find({ where: { id: In(list) }, select: { id: true, referenceNumber: true } });
  for (const row of rows) {
    result.set(row.id, row.referenceNumber);
  }
  return result;
}
```

```typescript
// src/modules/cases/case-names.ts
import { Case } from './entities/case.entity';
import { CaseCategory } from '../master-data/entities/case-category.entity';
import { CaseType } from '../master-data/entities/case-type.entity';
import { Department } from '../master-data/entities/department.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';
import { loadNamesById, loadUserNames, type NameSource } from '../../shared/name-lookup';

export type CaseNameFields = {
  requesterName: string | null;
  requesterDesignation: string | null;
  assignedLegalRepName: string | null;
  assignedLegalRepRole: string | null;
  categoryName: string | null;
  caseTypeName: string | null;
  departmentName: string | null;
  entityName: string | null;
  businessUnitName: string | null;
};

export async function withCaseNames<T extends Case>(source: NameSource, rows: T[]): Promise<Array<T & CaseNameFields>> {
  const [users, categories, types, departments, entities, units] = await Promise.all([
    loadUserNames(source, rows.flatMap((row) => [row.requesterId, row.assignedLegalRepId])),
    loadNamesById(source, CaseCategory, rows.map((row) => row.categoryId)),
    loadNamesById(source, CaseType, rows.map((row) => row.caseTypeId)),
    loadNamesById(source, Department, rows.map((row) => row.departmentId)),
    loadNamesById(source, OrgEntity, rows.map((row) => row.entityId)),
    loadNamesById(source, BusinessUnit, rows.map((row) => row.businessUnitId)),
  ]);
  return rows.map((row) => {
    const requester = users.get(row.requesterId);
    const assignee = row.assignedLegalRepId ? users.get(row.assignedLegalRepId) : undefined;
    return {
      ...row,
      requesterName: requester?.fullName ?? null,
      requesterDesignation: requester?.designation ?? null,
      assignedLegalRepName: assignee?.fullName ?? null,
      assignedLegalRepRole: assignee?.role ?? null,
      categoryName: categories.get(row.categoryId) ?? null,
      caseTypeName: types.get(row.caseTypeId) ?? null,
      departmentName: departments.get(row.departmentId) ?? null,
      entityName: entities.get(row.entityId) ?? null,
      businessUnitName: row.businessUnitId ? (units.get(row.businessUnitId) ?? null) : null,
    };
  });
}
```

`caseResponseSchema` — add (all `z.string().nullable()`): `requesterName`, `requesterDesignation`, `assignedLegalRepName`, `assignedLegalRepRole`, `categoryName`, `caseTypeName`, `departmentName`, `entityName`, `businessUnitName`.

`src/modules/cases/cases.routes.ts` — change `serializeCase` to accept `Case & { slaState; caseAgeHours } & CaseNameFields` and add one local helper used by every route that returns a case:

```typescript
async function respondCase(dataSource: DataSource, caseRow: Case) {
  const [named] = await withCaseNames(dataSource, [toCaseWithSla(caseRow)]);
  return serializeCase(named);
}
```

Replace each `serializeCase(toCaseWithSla(caseRow))` / `serializeCase(caseRow)` site (detail, create, update, assign, accept, reject, close, escalate, priority) with `await respondCase(app.dataSource, caseRow)` (for the detail route, `getCaseById` already returns the SLA-decorated row — pass it through `withCaseNames` the same way; avoid computing SLA twice by letting `respondCase` accept an already-decorated row if needed). The list route becomes:

```typescript
    const result = await listCases(app.dataSource, actor, request.query);
    const named = await withCaseNames(app.dataSource, result.items);
    return { ...result, items: named.map(serializeCase) };
```

`GET /cases/export`: `const named = await withCaseNames(app.dataSource, rows);` then `toCsv(named, CASE_EXPORT_COLUMNS)`; `CASE_EXPORT_COLUMNS` (in `cases.export.ts`) gains, **after the existing id columns**, `requesterName`, `assignedLegalRepName`, `categoryName`, `caseTypeName`, `departmentName`, `entityName`, `businessUnitName` (typed on `ExportCase & CaseNameFields`).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/cases && npx tsc --noEmit`
Expected: PASS (new file plus every existing cases test; existing response assertions use `toMatchObject`/field checks, if one uses a strict `toEqual` on a whole case, update it for the new fields and list it in your report), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-03-case-names.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/shared/name-lookup.ts src/modules/cases test/integration/modules/cases/case-names.test.ts decisions.md decisions/frontend-integration/task-03-case-names.md
git commit -m "feat: names on case responses and exports via batched lookups"
```

---

### Task 4: Names on comments, information requests, documents, notifications and audit rows; audit date filter

**Files:**
- Modify: `src/modules/comments/comments.schemas.ts`, `comments.routes.ts`
- Modify: `src/modules/information-requests/information-requests.schemas.ts`, `information-requests.routes.ts`
- Modify: `src/modules/documents/documents.schemas.ts`, `documents.routes.ts`
- Modify: `src/modules/notifications/notifications.schemas.ts`, `notifications.routes.ts`
- Create: `src/modules/audit/audit.serialize.ts`
- Modify: `src/modules/audit/audit.schemas.ts` (date filter, new row fields), `audit.routes.ts` (names, date filter, export columns)
- Test: `test/integration/modules/audit/audit-names-and-dates.test.ts`
- Test: `test/integration/modules/comments/comment-names.test.ts`
- Test: `test/integration/modules/information-requests/information-request-names.test.ts`
- Test: `test/integration/modules/documents/document-names.test.ts`
- Test: `test/integration/modules/notifications/notification-case-reference.test.ts`

**Interfaces:**
- Consumes: `loadUserNames`, `loadCaseReferences` (Task 3).
- Produces:
  - comment responses gain `authorName`, `authorRole`; information request responses gain `raisedByName`, `raisedByRole`, `responderName`; document and version responses gain `uploadedByName`; notification responses gain `relatedCaseReference`; all `string | null`
  - `auditDateRangeSchema` (query: optional `createdFrom`, `createdTo` as coerced dates, refine `createdFrom <= createdTo`, 400 otherwise) exported from `audit.schemas.ts`; `auditQuerySchema` and the export query extend it
  - audit rows (`GET /audit`, `GET /audit/export`) carry `actorName`, `actorRole`, `caseReference`; `serializeAuditRows(source, rows): Promise<AuditRowResponse[]>` exported from `audit.serialize.ts` (used again by Task 8); the audit CSV export gains `actorName`, `actorRole`, `caseReference` columns after the existing columns.

- [ ] **Step 1: Write the failing tests**

Write one test file per area. Seed the data with the existing fixtures (`seedCaseWithParties`, `seedComment`, `seedInformationRequest`, `seedDocument`, `seedNotification`, `logAuditEvent`) and assert the new fields through the HTTP routes. Required assertions (write them in the style of Task 3's test file):

```typescript
// comment-names.test.ts — GET /cases/:id/comments, POST /cases/:id/comments, PATCH /comments/:id
//   - author with fullName 'Lina Lawyer' (role legal_rep) → items[].authorName === 'Lina Lawyer', authorRole === 'legal_rep'
//   - a requester reading the thread sees the lawyer's name (not hidden)
// information-request-names.test.ts — list, raise, respond, reopen responses
//   - raisedByName / raisedByRole for the rep who raised it, responderName for the responder
// document-names.test.ts — GET /cases/:id/documents, upload, GET /documents/:id/versions
//   - uploadedByName for the uploader on list, upload response and every version
// notification-case-reference.test.ts — GET /notifications and PATCH /notifications/:id/read
//   - a notification with relatedCaseId → relatedCaseReference === the case referenceNumber
//   - a notification with no related case → relatedCaseReference === null
```

```typescript
// test/integration/modules/audit/audit-names-and-dates.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { authHeader } from '../../helpers/auth-header';

describe('audit names and date filter', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('rows carry the actor name and role and the case reference', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const adminId = await seedUserWithRole(ds, 'admin', { fullName: 'Amal Admin' });
    await logAuditEvent(ds, { actorId: adminId, caseId: caseRow.id, action: 'case.updated' });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created' });

    const res = await app.inject({ method: 'GET', url: '/audit', headers: authHeader(app, adminId, 'admin') });

    const withCase = res.json().items.find((item: { action: string }) => item.action === 'case.updated');
    const withoutCase = res.json().items.find((item: { action: string }) => item.action === 'user.created');
    expect(withCase).toMatchObject({ actorName: 'Amal Admin', actorRole: 'admin', caseReference: caseRow.referenceNumber });
    expect(withoutCase).toMatchObject({ actorName: 'Amal Admin', caseReference: null });
    await app.close();
  });

  it('createdFrom and createdTo narrow the list and the export, inclusively, and combine with other filters', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    for (const [action, when] of [['old.event', '2026-01-10T00:00:00Z'], ['mid.event', '2026-02-10T00:00:00Z'], ['new.event', '2026-03-10T00:00:00Z']]) {
      await logAuditEvent(ds, { actorId: adminId, action });
      await ds.query(`UPDATE audit_log SET "createdAt" = $1 WHERE action = $2`, [when, action]);
    }
    const headers = authHeader(app, adminId, 'admin');

    const window = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-02-10T00:00:00Z&createdTo=2026-03-10T00:00:00Z', headers });
    const onlyFrom = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-03-01T00:00:00Z', headers });
    const combined = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-01-01T00:00:00Z&action=old.event', headers });
    const exported = await app.inject({ method: 'GET', url: '/audit/export?createdTo=2026-01-31T00:00:00Z', headers });

    expect(window.json().items.map((i: { action: string }) => i.action).sort()).toEqual(['mid.event', 'new.event']);
    expect(onlyFrom.json().items.map((i: { action: string }) => i.action)).toEqual(['new.event']);
    expect(combined.json().total).toBe(1);
    expect(exported.body).toContain('old.event');
    expect(exported.body).not.toContain('mid.event');
    await app.close();
  });

  it('rejects createdFrom after createdTo and unparsable dates with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    const headers = authHeader(app, adminId, 'admin');

    const reversed = await app.inject({ method: 'GET', url: '/audit?createdFrom=2026-03-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z', headers });
    const garbage = await app.inject({ method: 'GET', url: '/audit?createdFrom=whenever', headers });
    const exportReversed = await app.inject({ method: 'GET', url: '/audit/export?createdFrom=2026-03-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z', headers });

    expect(reversed.statusCode).toBe(400);
    expect(garbage.statusCode).toBe(400);
    expect(exportReversed.statusCode).toBe(400);
    await app.close();
  });

  it('the CSV export includes the name and reference columns', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const adminId = await seedUserWithRole(ds, 'admin', { fullName: 'Amal Admin' });
    await logAuditEvent(ds, { actorId: adminId, caseId: caseRow.id, action: 'case.updated' });

    const res = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, adminId, 'admin') });

    const lines = res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('actorName');
    expect(lines[0]).toContain('actorRole');
    expect(lines[0]).toContain('caseReference');
    expect(res.body).toContain('Amal Admin');
    expect(res.body).toContain(caseRow.referenceNumber);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/integration/modules/audit/audit-names-and-dates.test.ts test/integration/modules/comments/comment-names.test.ts test/integration/modules/information-requests/information-request-names.test.ts test/integration/modules/documents/document-names.test.ts test/integration/modules/notifications/notification-case-reference.test.ts`
Expected: FAIL — name fields are undefined; date params are ignored.

- [ ] **Step 3: Implement**

For each of comments, information requests and documents: change the module's `serialize…` function to take a second argument `names: Map<string, UserName>` (and add the new fields from it), and in every route handler that returns rows, load the names once for the whole response, for example (comments):

```typescript
export function serializeComment(row: CaseComment, names: Map<string, UserName>) {
  const author = names.get(row.authorId);
  return { /* existing fields */, authorName: author?.fullName ?? null, authorRole: author?.role ?? null };
}
// list handler:
    const names = await loadUserNames(app.dataSource, rows.map((row) => row.authorId));
    return rows.map((row) => serializeComment(row, names));
// create/edit handlers: the same with a single-element id list.
```

Information requests: `raisedByName/raisedByRole` from `raisedById`, `responderName` from `responderId` (one `loadUserNames` call with both ids). Documents: `uploadedByName` from `uploaderId` (all five `serializeDocument` sites). Add the fields (`z.string().nullable()`) to each response schema.

Notifications: `relatedCaseReference` — in `GET /notifications` call `loadCaseReferences(app.dataSource, items.map((i) => i.relatedCaseId))` once and pass the map to `serializeNotification(row, refs)`; the mark-read handler loads the single reference. Add `relatedCaseReference: z.string().nullable()` to `notificationResponseSchema`.

Audit:

```typescript
// src/modules/audit/audit.schemas.ts
export const auditDateRangeSchema = z
  .object({ createdFrom: z.coerce.date().optional(), createdTo: z.coerce.date().optional() })
  .refine((q) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo, {
    message: 'createdFrom must not be after createdTo',
    path: ['createdFrom'],
  });
```

Because `.refine` returns an effects wrapper, build the query schemas with `z.intersection` or define the raw shape once and apply the refine at the end, for example:

```typescript
const auditFilterShape = {
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
  caseId: z.string().uuid().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
};
const dateOrder = (q: { createdFrom?: Date; createdTo?: Date }) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo;
const dateOrderMessage = { message: 'createdFrom must not be after createdTo', path: ['createdFrom'] };

export const auditQuerySchema = paginationQuerySchema.extend(auditFilterShape).refine(dateOrder, dateOrderMessage);
export const auditExportQuerySchema = z.object(auditFilterShape).refine(dateOrder, dateOrderMessage);
```

Export `auditFilterShape`, `dateOrder` and `dateOrderMessage` so Task 8 reuses them. Extend `auditListResponseSchema` rows with `caseReference`, `actorName`, `actorRole` (all `z.string().nullable()` except `actorId`).

```typescript
// src/modules/audit/audit.serialize.ts
import type { AuditLog } from './entities/audit-log.entity';
import { loadCaseReferences, loadUserNames, type NameSource } from '../../shared/name-lookup';

export async function serializeAuditRows(source: NameSource, rows: AuditLog[]) {
  const [users, references] = await Promise.all([
    loadUserNames(source, rows.map((row) => row.actorId)),
    loadCaseReferences(source, rows.map((row) => row.caseId)),
  ]);
  return rows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseReference: row.caseId ? (references.get(row.caseId) ?? null) : null,
    actorId: row.actorId,
    actorName: users.get(row.actorId)?.fullName ?? null,
    actorRole: users.get(row.actorId)?.role ?? null,
    action: row.action,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    createdAt: row.createdAt.toISOString(),
  }));
}
```

In `audit.routes.ts` build the filtered query with a QueryBuilder so the date range can be applied: `where.actorId/action/caseId` as before plus `createdAt >= createdFrom` / `<= createdTo`; list uses `serializeAuditRows` after `getManyAndCount`; export uses the same filters with `take(cap)` and the extra columns `actorName`, `actorRole`, `caseReference` appended after the existing ones (`serializeAuditRows` output feeds the CSV).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/audit test/integration/modules/comments test/integration/modules/information-requests test/integration/modules/documents test/integration/modules/notifications && npx tsc --noEmit`
Expected: PASS (new and existing; adjust a strict whole-object `toEqual` in an existing test only for the new fields and list it in the report), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-04-names-and-audit-dates.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/modules/comments src/modules/information-requests src/modules/documents src/modules/notifications src/modules/audit test/integration/modules decisions.md decisions/frontend-integration/task-04-names-and-audit-dates.md
git commit -m "feat: names on comment, request, document, notification and audit responses plus audit date filter"
```

---

### Task 5: Extra intake fields

**Files:**
- Create: `src/db/migrations/1700000014000-add-intake-fields-to-cases.ts`; modify `src/db/migrations/index.ts`
- Modify: `src/modules/cases/entities/case.entity.ts`
- Modify: `src/modules/cases/cases.schemas.ts` (create, update, response)
- Modify: `src/modules/cases/cases.service.ts` (`CreateCaseInput`, `UpdateCaseInput`, `submitCase`, `updateCase`)
- Modify: `test/integration/helpers/seed-case.ts` (new overrides)
- Test: `test/integration/modules/cases/intake-fields.test.ts`

**Interfaces:**
- Produces: nullable columns `contactName varchar(200)`, `contactEmail varchar(320)`, `contactPhone varchar(50)`, `desiredOutcome text`, `incidentDate date`, `businessDeadline date`, `counterparty varchar(300)`, `estimatedValue numeric(14,2)`, `thirdPartyDetails text`, and `isConfidential boolean NOT NULL DEFAULT false` on `cases`; accepted by `POST /cases` and `PATCH /cases/:id` (while Submitted) and returned in every case response; `seedCase` accepts the same names as overrides (`isConfidential` defaults false).
- Rules: `contactEmail` must be a valid email, `estimatedValue` is a number ≥ 0 (max 9 999 999 999 999.99), dates are ISO `YYYY-MM-DD`, long texts max 5000 characters; empty or whitespace-only strings count as absent on create; on PATCH `null` clears a field. `estimatedValue` is read back as a number, `incidentDate`/`businessDeadline` as `YYYY-MM-DD` strings or null.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/cases/intake-fields.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('extra intake fields and the confidential flag', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  async function internalIds() {
    const [category] = await ds.query(`SELECT id FROM case_categories WHERE name = 'Internal'`);
    const [caseType] = await ds.query(
      `INSERT INTO case_types (id, "categoryId", name, "slaAckHours", "slaResolutionHours") VALUES (gen_random_uuid(), $1, $2, 24, 72) RETURNING id`,
      [category.id, `Internal-Type-${Date.now()}-${Math.random()}`],
    );
    return { categoryId: category.id as string, caseTypeId: caseType.id as string };
  }

  async function requesterWorld() {
    const master = await seedCaseMasterData(ds);
    const ids = await internalIds();
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
    const payload = {
      title: 'Need contract review',
      description: 'This case description is definitely at least twenty characters.',
      declarationConfirmed: true,
      categoryId: ids.categoryId,
      caseTypeId: ids.caseTypeId,
      departmentId: master.departmentId,
    };
    return { master, requesterId, payload };
  }

  it('creates a case with every extra field and returns them', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: authHeader(app, requesterId, 'requester'),
      payload: {
        ...payload,
        isConfidential: true,
        contactName: 'Omar Al-Zahrani',
        contactEmail: 'omar@algihaz.example',
        contactPhone: '+966 11 000 0000',
        desiredOutcome: 'Renewed agreement with better exit rights.',
        incidentDate: '2026-08-17',
        businessDeadline: '2026-09-28',
        counterparty: 'Zahran Equipment Co.',
        estimatedValue: 8900000.5,
        thirdPartyDetails: 'Contract no. 4471, supplier since 2019.',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      isConfidential: true,
      contactName: 'Omar Al-Zahrani',
      contactEmail: 'omar@algihaz.example',
      contactPhone: '+966 11 000 0000',
      desiredOutcome: 'Renewed agreement with better exit rights.',
      incidentDate: '2026-08-17',
      businessDeadline: '2026-09-28',
      counterparty: 'Zahran Equipment Co.',
      estimatedValue: 8900000.5,
      thirdPartyDetails: 'Contract no. 4471, supplier since 2019.',
    });
    await app.close();
  });

  it('defaults to not confidential with every optional field null', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      isConfidential: false, contactName: null, contactEmail: null, contactPhone: null, desiredOutcome: null,
      incidentDate: null, businessDeadline: null, counterparty: null, estimatedValue: null, thirdPartyDetails: null,
    });
    await app.close();
  });

  it('treats empty and whitespace-only strings as absent on create', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({
      method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'),
      payload: { ...payload, contactName: '', contactEmail: '   ', counterparty: '' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ contactName: null, contactEmail: null, counterparty: null });
    await app.close();
  });

  it.each([
    ['a bad email', { contactEmail: 'not-an-email' }],
    ['a negative value', { estimatedValue: -1 }],
    ['an impossible date', { incidentDate: '2026-13-45' }],
    ['a non-ISO date', { businessDeadline: '28/09/2026' }],
    ['an over-long description', { desiredOutcome: 'x'.repeat(5001) }],
    ['an over-long contact name', { contactName: 'x'.repeat(201) }],
  ])('rejects %s with 400', async (_label, extra) => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload: { ...payload, ...extra } });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH sets, changes and clears the fields while the case is Submitted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { master, requesterId } = await requesterWorld();
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    const headers = authHeader(app, requesterId, 'requester');

    const set = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers, payload: { isConfidential: true, counterparty: 'Acme', estimatedValue: 100 } });
    const clear = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers, payload: { counterparty: null, estimatedValue: null } });

    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ isConfidential: true, counterparty: 'Acme', estimatedValue: 100 });
    expect(clear.json()).toMatchObject({ isConfidential: true, counterparty: null, estimatedValue: null });
    await app.close();
  });

  it('PATCH is refused once the case has left Submitted (existing rule)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { master, requesterId } = await requesterWorld();
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress' });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers: authHeader(app, requesterId, 'requester'), payload: { isConfidential: true } });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('the edit audit entry records the changed intake fields', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { master, requesterId } = await requesterWorld();
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });

    await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers: authHeader(app, requesterId, 'requester'), payload: { counterparty: 'Acme' } });

    const [row] = await ds.query(`SELECT "beforeValue", "afterValue" FROM audit_log WHERE "caseId" = $1 AND action = 'case.updated'`, [caseRow.id]);
    expect(row.afterValue.counterparty).toBe('Acme');
    expect(row.beforeValue.counterparty).toBeNull();
    await app.close();
  });

  it('migration columns round-trip through the fixture', async () => {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });

    const row = await seedCase(ds, { ...master, requesterId, isConfidential: true, counterparty: 'Seeded Co.', estimatedValue: 12.5 });

    expect(row.isConfidential).toBe(true);
    expect(row.counterparty).toBe('Seeded Co.');
    expect(row.estimatedValue).toBe(12.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/cases/intake-fields.test.ts`
Expected: FAIL — unknown fields are stripped, `seedCase` rejects the new overrides.

- [ ] **Step 3: Implement**

Migration:

```typescript
// src/db/migrations/1700000014000-add-intake-fields-to-cases.ts
import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddIntakeFieldsToCases1700000014000 implements MigrationInterface {
  name = 'AddIntakeFieldsToCases1700000014000';

  private readonly columns = [
    new TableColumn({ name: 'isConfidential', type: 'boolean', default: false }),
    new TableColumn({ name: 'contactName', type: 'varchar', length: '200', isNullable: true }),
    new TableColumn({ name: 'contactEmail', type: 'varchar', length: '320', isNullable: true }),
    new TableColumn({ name: 'contactPhone', type: 'varchar', length: '50', isNullable: true }),
    new TableColumn({ name: 'desiredOutcome', type: 'text', isNullable: true }),
    new TableColumn({ name: 'incidentDate', type: 'date', isNullable: true }),
    new TableColumn({ name: 'businessDeadline', type: 'date', isNullable: true }),
    new TableColumn({ name: 'counterparty', type: 'varchar', length: '300', isNullable: true }),
    new TableColumn({ name: 'estimatedValue', type: 'numeric', precision: 14, scale: 2, isNullable: true }),
    new TableColumn({ name: 'thirdPartyDetails', type: 'text', isNullable: true }),
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('cases', this.columns);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('cases', this.columns.map((column) => column.name));
  }
}
```

Register it in `src/db/migrations/index.ts`.

Entity columns (add to `Case`):

```typescript
  @Column({ type: 'boolean', default: false })
  isConfidential!: boolean;

  @Column({ type: 'varchar', length: 200, nullable: true })
  contactName!: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  contactEmail!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  contactPhone!: string | null;

  @Column({ type: 'text', nullable: true })
  desiredOutcome!: string | null;

  @Column({ type: 'date', nullable: true })
  incidentDate!: string | null;

  @Column({ type: 'date', nullable: true })
  businessDeadline!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  counterparty!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  estimatedValue!: number | null;

  @Column({ type: 'text', nullable: true })
  thirdPartyDetails!: string | null;
```

Schemas (`cases.schemas.ts`):

```typescript
const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.string().trim().max(320).email().optional());
const optionalDate = z.preprocess(blankToUndefined, z.iso.date().optional());
const optionalMoney = z.number().min(0).max(9_999_999_999_999.99).optional();

const intakeFields = {
  isConfidential: z.boolean().default(false),
  contactName: optionalText(200),
  contactEmail: optionalEmail,
  contactPhone: optionalText(50),
  desiredOutcome: optionalText(5000),
  incidentDate: optionalDate,
  businessDeadline: optionalDate,
  counterparty: optionalText(300),
  estimatedValue: optionalMoney,
  thirdPartyDetails: optionalText(5000),
};
// createCaseBodySchema = z.object({ ...existing, ...intakeFields })
// updateCaseBodySchema: the same keys, each made .nullable().optional() (null clears) and isConfidential: z.boolean().optional()
```

Response schema: add `isConfidential: z.boolean()` and the nine fields as `z.string().nullable()` (`estimatedValue: z.number().nullable()`, dates as `z.string().nullable()`). `CreateCaseInput` / `UpdateCaseInput` gain the same keys. `submitCase` stores them (`?? null`); `updateCase` applies `input.x !== undefined → caseRow.x = input.x`, and `before`/`after` in the `case.updated` audit entry include **all** the intake fields. `serializeCase` needs no change besides passing the fields through (they are already on the row). `seedCase` overrides gain the same names and set them on the created row (`isConfidential` default false, the rest default null).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/cases && npx tsc --noEmit`
Expected: PASS, `tsc` clean. Run `npx vitest run test/integration/modules/notifications test/integration/modules/dashboards-reports` as regression (they seed cases).

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-05-intake-fields.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/db/migrations src/modules/cases test/integration/helpers/seed-case.ts test/integration/modules/cases/intake-fields.test.ts decisions.md decisions/frontend-integration/task-05-intake-fields.md
git commit -m "feat: optional intake fields and confidential flag on cases"
```

---

### Task 6: Confidential case visibility

**Files:**
- Modify: `src/modules/cases/cases.service.ts` (`applyCaseFilters` requester block → shared visibility, `getCaseById`)
- Test: `test/integration/modules/cases/confidential-visibility.test.ts`

**Interfaces:**
- Consumes: `isConfidential` (Task 5), `applyCaseFilters`, `getCaseById`.
- Produces: `canActorSeeCase(source, actor, caseRow): Promise<boolean>` (exported) and an updated visibility rule inside `applyCaseFilters` — requester: `(same department AND not confidential) OR requesterId = me OR information-request responder`; viewer: `not confidential`; admin, legal manager, legal rep: unchanged (see everything). `getCaseById` answers 404 for a case `canActorSeeCase` rejects.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/cases/confidential-visibility.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { seedComment } from '../../helpers/seed-comment';
import { authHeader } from '../../helpers/auth-header';

describe('confidential case visibility', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  // C = confidential case, N = ordinary case, both in department D submitted by `submitter`.
  async function world() {
    const master = await seedCaseMasterData(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const dept = { departmentId: master.departmentId, entityId: master.entityId };
    const submitter = await seedUserWithRole(ds, 'requester', dept);
    const colleague = await seedUserWithRole(ds, 'requester', dept);
    const responder = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    const admin = await seedUserWithRole(ds, 'admin');
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const rep = await seedUserWithRole(ds, 'legal_rep');
    const viewer = await seedUserWithRole(ds, 'viewer');
    const confidential = await seedCase(ds, { ...master, requesterId: submitter, referenceNumber: 'CONF-1', isConfidential: true, status: 'In Progress', assignedLegalRepId: rep });
    const ordinary = await seedCase(ds, { ...master, requesterId: submitter, referenceNumber: 'PLAIN-1', status: 'In Progress', assignedLegalRepId: rep });
    await seedInformationRequest(ds, { caseId: confidential.id, raisedById: rep, responderId: responder });
    await seedComment(ds, { caseId: confidential.id, authorId: rep, body: 'legal chatter' });
    return { master, submitter, colleague, responder, admin, manager, rep, viewer, confidential, ordinary };
  }

  const seesConfidential = ['admin', 'manager', 'rep', 'submitter', 'responder'] as const;
  const hidden = ['colleague', 'viewer'] as const;
  const roleOf = { admin: 'admin', manager: 'legal_manager', rep: 'legal_rep', submitter: 'requester', responder: 'requester', colleague: 'requester', viewer: 'viewer' } as const;

  it.each([...seesConfidential])('%s sees the confidential case in the list, by id and by search', async (who) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w[who], roleOf[who]);

    const list = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers });
    const detail = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}`, headers });
    const search = await app.inject({ method: 'GET', url: '/cases?search=CONF-1', headers });

    expect(list.json().items.map((i: { referenceNumber: string }) => i.referenceNumber)).toContain('CONF-1');
    expect(detail.statusCode).toBe(200);
    expect(search.json().total).toBe(1);
    await app.close();
  });

  it.each([...hidden])('%s never learns the confidential case exists (list, detail, search, sub-resources)', async (who) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w[who], roleOf[who]);

    const list = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers });
    const detail = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}`, headers });
    const search = await app.inject({ method: 'GET', url: '/cases?search=CONF-1', headers });
    const comments = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/comments`, headers });
    const documents = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/documents`, headers });
    const requests = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/information-requests`, headers });

    expect(list.json().items.map((i: { referenceNumber: string }) => i.referenceNumber)).not.toContain('CONF-1');
    expect(list.json().items.map((i: { referenceNumber: string }) => i.referenceNumber)).toContain('PLAIN-1');
    expect(detail.statusCode).toBe(404);
    expect(search.json().total).toBe(0);
    expect(comments.statusCode).toBe(404);
    expect(documents.statusCode).toBe(404);
    expect(requests.statusCode).toBe(404);
    await app.close();
  });

  it('the hidden case is excluded from dashboard counts and from the dashboard panels for a viewer and a colleague', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const viewer = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.viewer, 'viewer') });
    const colleague = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.colleague, 'requester') });
    const manager = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.manager, 'legal_manager') });

    expect(viewer.json().tiles.total).toBe(1);
    expect(colleague.json().tiles.total).toBe(1);
    expect(manager.json().tiles.total).toBe(2);
    await app.close();
  });

  it('a viewer\'s report figures and exports exclude the confidential case', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.viewer, 'viewer');

    const ageing = await app.inject({ method: 'GET', url: '/reports/ageing', headers });
    const volume = await app.inject({ method: 'GET', url: '/reports/volume-by-category', headers });
    const caseExport = await app.inject({ method: 'GET', url: '/cases/export', headers });
    const managerExport = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, w.manager, 'legal_manager') });

    const openTotal = ageing.json().reduce((sum: number, row: { count: number }) => sum + row.count, 0);
    const volumeTotal = volume.json().reduce((sum: number, row: { count: number }) => sum + row.count, 0);
    expect(openTotal).toBe(1);
    expect(volumeTotal).toBe(1);
    expect(caseExport.body).not.toContain('CONF-1');
    expect(caseExport.body).toContain('PLAIN-1');
    expect(managerExport.body).toContain('CONF-1');
    await app.close();
  });

  it('the information-request responder sees the case and its information requests but not other confidential cases', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const other = await seedCase(ds, { ...w.master, requesterId: w.submitter, referenceNumber: 'CONF-2', isConfidential: true });
    const headers = authHeader(app, w.responder, 'requester');

    const requests = await app.inject({ method: 'GET', url: `/cases/${w.confidential.id}/information-requests`, headers });
    const otherDetail = await app.inject({ method: 'GET', url: `/cases/${other.id}`, headers });

    expect(requests.statusCode).toBe(200);
    expect(otherDetail.statusCode).toBe(404);
    await app.close();
  });

  it('a requester always sees a non-confidential case they submitted themselves, even for another department', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const elsewhere = await seedCaseMasterData(ds);
    const mine = await seedCase(ds, { ...elsewhere, requesterId: w.submitter, referenceNumber: 'MINE-OTHERDEPT' });

    const res = await app.inject({ method: 'GET', url: `/cases/${mine.id}`, headers: authHeader(app, w.submitter, 'requester') });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('non-confidential behaviour is unchanged: colleagues see it, viewers see it, other departments do not', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const stranger = await seedCaseMasterData(ds);
    const strangerRequester = await seedUserWithRole(ds, 'requester', { departmentId: stranger.departmentId, entityId: stranger.entityId });

    const colleague = await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers: authHeader(app, w.colleague, 'requester') });
    const viewer = await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers: authHeader(app, w.viewer, 'viewer') });
    const outsider = await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers: authHeader(app, strangerRequester, 'requester') });

    expect(colleague.statusCode).toBe(200);
    expect(viewer.statusCode).toBe(200);
    expect(outsider.statusCode).toBe(404);
    await app.close();
  });

  it('flipping the flag takes effect immediately for a colleague', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.colleague, 'requester');
    expect((await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers })).statusCode).toBe(200);

    await ds.query(`UPDATE cases SET "isConfidential" = true WHERE id = $1`, [w.ordinary.id]);

    expect((await app.inject({ method: 'GET', url: `/cases/${w.ordinary.id}`, headers })).statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/cases/confidential-visibility.test.ts`
Expected: FAIL — the viewer and the colleague still see the confidential case.

- [ ] **Step 3: Implement**

In `src/modules/cases/cases.service.ts`, replace the requester block at the top of `applyCaseFilters` with:

```typescript
  if (actor.role === 'viewer') {
    qb.andWhere('c."isConfidential" = false');
  }
  if (actor.role === 'requester') {
    qb.andWhere(
      `((c."departmentId" = :actorDepartmentId AND c."isConfidential" = false)
        OR c."requesterId" = :actorId
        OR EXISTS (SELECT 1 FROM information_requests ir WHERE ir."caseId" = c.id AND ir."responderId" = :actorId))`,
      { actorDepartmentId: actor.departmentId, actorId: actor.id },
    );
  }
```

Add the single-case counterpart and use it in `getCaseById`:

```typescript
export async function canActorSeeCase(source: DataSource | EntityManager, actor: Actor, caseRow: Case): Promise<boolean> {
  if (actor.role === 'viewer') {
    return !caseRow.isConfidential;
  }
  if (actor.role !== 'requester') {
    return true;
  }
  if (caseRow.requesterId === actor.id) {
    return true;
  }
  if (caseRow.departmentId === actor.departmentId && !caseRow.isConfidential) {
    return true;
  }
  // AC-04: a requester also sees a case when an information request on it is assigned to them.
  const count = await source.getRepository(InformationRequest).count({ where: { caseId: caseRow.id, responderId: actor.id } });
  return count > 0;
}

// in getCaseById, replace the whole `if (actor.role === 'requester' && ...)` block with:
  if (!(await canActorSeeCase(dataSource, actor, caseRow))) {
    throw new NotFoundError('Case not found');
  }
```

Keep the existing explanatory comment about the leaf-module import. The dashboard, reports, exports and every sub-resource inherit the rule through `applyCaseFilters` and `getCaseById`; do not duplicate the rule anywhere else. If any other code reads cases for a requester or viewer without going through these two (search with `grep -rn "getRepository(Case)" src`), report each place and apply `applyCaseFilters` or `canActorSeeCase` there.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules && npx tsc --noEmit`
Expected: PASS for the new file and the whole existing module suites, `tsc` clean. An existing test that relied on a requester not seeing a case they submitted in another department must be updated and listed in the report.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-06-confidential-visibility.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/modules/cases/cases.service.ts test/integration/modules/cases/confidential-visibility.test.ts decisions.md decisions/frontend-integration/task-06-confidential-visibility.md
git commit -m "feat: hide confidential cases from viewers and unrelated requesters"
```

---

### Task 7: Dashboard changes

**Files:**
- Modify: `src/modules/dashboards-reports/dashboard.service.ts`, `dashboard.schemas.ts`
- Modify: `test/integration/modules/dashboards-reports/dashboard.test.ts` (update expectations for the new scope and tiles; keep every assertion's intent)
- Test: `test/integration/modules/dashboards-reports/dashboard-rep-scope.test.ts`

**Interfaces:**
- Consumes: `applyCaseFilters`, `loadUserNames` (Tasks 3, 6).
- Produces:
  - `tiles` gains `assignedToMe` (open cases assigned to the caller; 0 when none) and `unassigned` (status Submitted); `filters` gains `assignedToMe: { open: 'true', assignedLegalRepId: <caller id> }` and `unassigned: { status: 'Submitted' }`
  - a legal rep's scope is organisation-wide (the per-rep `tileFiltersFor` workaround is removed; every role now gets the static `TILE_FILTERS` plus the dynamic `assignedToMe`)
  - `myAssignedCases` (legal rep only) = the rep's **open** cases (every non-Closed status), oldest first by `createdAt`, at most 20; every panel item gains `assignedLegalRepName: string | null`

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/dashboards-reports/dashboard-rep-scope.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithTimes } from '../../helpers/seed-case-times';
import { authHeader } from '../../helpers/auth-header';

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

describe('dashboard for a legal rep', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  // 5 cases: Submitted (unassigned), Assigned to rep, In Progress to rep, Waiting to other rep, Closed to rep
  async function world() {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Lina Lawyer' });
    const otherRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Other Rep' });
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const base = { ...master, requesterId, resolutionDueAt: inHours(48) };
    const submitted = await seedCaseWithTimes(ds, { ...base, status: 'Submitted', createdAt: inHours(-5) });
    const assigned = await seedCaseWithTimes(ds, { ...base, status: 'Assigned', assignedLegalRepId: repId, createdAt: inHours(-4) });
    const inProgress = await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: repId, createdAt: inHours(-100) });
    const waiting = await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', assignedLegalRepId: otherRepId, createdAt: inHours(-3) });
    const closed = await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: repId, closedAt: inHours(-1), createdAt: inHours(-50) });
    return { repId, otherRepId, requesterId, submitted, assigned, inProgress, waiting, closed };
  }

  it('a legal rep gets organisation-wide tiles plus assignedToMe and unassigned', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.repId, 'legal_rep') });

    expect(res.statusCode).toBe(200);
    expect(res.json().tiles).toMatchObject({ total: 5, open: 4, awaitingAcceptance: 1, waitingOnInput: 1, closed: 1, assignedToMe: 2, unassigned: 1 });
    expect(res.json().filters.assignedToMe).toEqual({ open: 'true', assignedLegalRepId: w.repId });
    expect(res.json().filters.unassigned).toEqual({ status: 'Submitted' });
    await app.close();
  });

  it('myAssignedCases lists the rep\'s open cases oldest first, each with status and the assignee name', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.repId, 'legal_rep') });

    const items = res.json().myAssignedCases;
    expect(items.map((item: { id: string }) => item.id)).toEqual([w.inProgress.id, w.assigned.id]);
    expect(items.map((item: { status: string }) => item.status)).toEqual(['In Progress', 'Assigned']);
    expect(items[0].assignedLegalRepName).toBe('Lina Lawyer');
    await app.close();
  });

  it('caps myAssignedCases at 20 and keeps the tile count exact', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    for (let i = 0; i < 22; i += 1) {
      await seedCaseWithTimes(ds, { ...master, requesterId, status: 'In Progress', assignedLegalRepId: repId, createdAt: inHours(-(100 - i)), referenceNumber: `REP-${String(i).padStart(2, '0')}` });
    }

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, repId, 'legal_rep') });

    expect(res.json().tiles.assignedToMe).toBe(22);
    expect(res.json().myAssignedCases).toHaveLength(20);
    expect(res.json().myAssignedCases[0].id).toBeTruthy();
    await app.close();
  });

  it('every tile filter replays through GET /cases to the same count for a rep, including the new tiles', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.repId, 'legal_rep');
    const dashboard = (await app.inject({ method: 'GET', url: '/dashboard', headers })).json();

    for (const tile of ['total', 'open', 'awaitingAcceptance', 'waitingOnInput', 'overdue', 'closed', 'assignedToMe', 'unassigned'] as const) {
      const params = new URLSearchParams({ ...dashboard.filters[tile], pageSize: '100' });
      const list = await app.inject({ method: 'GET', url: `/cases?${params.toString()}`, headers });
      expect(list.json().total, tile).toBe(dashboard.tiles[tile]);
    }
    await app.close();
  });

  it('assignedToMe is 0 for roles that cannot hold assignments, and panels carry the assignee name', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const manager = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });
    const requester = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, w.requesterId, 'requester') });

    expect(manager.json().tiles.assignedToMe).toBe(0);
    expect(requester.json().tiles.assignedToMe).toBe(0);
    const awaiting = manager.json().managerPanels.awaitingAcceptance.items[0];
    expect(awaiting.assignedLegalRepName).toBe('Lina Lawyer');
    const unassigned = manager.json().managerPanels.unassigned.items[0];
    expect(unassigned.assignedLegalRepName).toBeNull();
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/dashboards-reports/dashboard-rep-scope.test.ts`
Expected: FAIL — tiles lack `assignedToMe`/`unassigned`, the rep tiles are scoped to the rep.

- [ ] **Step 3: Implement**

`dashboard.schemas.ts`: add `assignedToMe`, `unassigned` to the `tiles` object (`countSchema`) and `assignedLegalRepName: z.string().nullable()` to `panelItemSchema`.

`dashboard.service.ts`:

- Delete `tileFiltersFor` and the legal-rep restriction in `scopedQuery` (`scopedQuery` becomes just `applyCaseFilters(qb, actor, {})`).
- `TILE_FILTERS` gains `unassigned: { status: 'Submitted' }`; the result's `filters` is `{ ...TILE_FILTERS, assignedToMe: { open: 'true', assignedLegalRepId: actor.id } }`.
- The tile query adds:

```typescript
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."assignedLegalRepId" = :tileActorId)`, 'assignedToMe')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Submitted')`, 'unassigned')
// and  .setParameter('tileActorId', actor.id)  on that query builder
```

- `panel(...)` gains the assignee name: load names once for the page with `loadUserNames(dataSource, rows.map((row) => row.assignedLegalRepId))` and add `assignedLegalRepName` to each item.
- `myAssignedCases` becomes the open-cases panel: replace the `panel(dataSource, actor, 'Assigned', true)` call by a new `assignedOpenPanel(dataSource, actor)` which uses `scopedQuery` plus `c."assignedLegalRepId" = :me AND c."status" != 'Closed'`, `ORDER BY c."createdAt" ASC, c."id" ASC LIMIT 20`, and the same item mapping (so `status` is present).

Update `test/integration/modules/dashboards-reports/dashboard.test.ts`: tiles gain the two new keys in every `toEqual`; the legal-rep expectations move to organisation-wide (tiles `total: 6, open: 4, awaitingAcceptance: 1, waitingOnInput: 1, overdue: 1, onTime: 5, closed: 2` plus `assignedToMe`/`unassigned`), `myAssignedCases` becomes the oldest-first open list (the in-progress and assigned cases of that rep), and the rep filter-replay test now expects the unqualified filters. Keep the intent of every assertion and list each changed expectation in your report.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/dashboards-reports && npx tsc --noEmit`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-07-dashboard-changes.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/modules/dashboards-reports test/integration/modules/dashboards-reports decisions.md decisions/frontend-integration/task-07-dashboard-changes.md
git commit -m "feat: organisation-wide lawyer dashboard with assigned-to-me and unassigned tiles"
```

---

### Task 8: Case audit endpoint

**Files:**
- Create: `src/modules/audit/case-audit.service.ts`
- Modify: `src/modules/audit/audit.routes.ts` (add `GET /cases/:id/audit`)
- Test: `test/integration/modules/audit/case-audit.test.ts`

**Interfaces:**
- Consumes: `getCaseById` (visibility gate, Task 6), `serializeAuditRows`, `auditFilterShape`/`dateOrder`/`dateOrderMessage` (Task 4), pagination helpers.
- Produces: `listCaseAudit(dataSource, actor, caseId, query: { page; pageSize; createdFrom?; createdTo? })` → `{ items, total, page, pageSize }` (rows shaped like the global audit rows) and `GET /cases/:id/audit` (any authenticated role that can see the case). For `requester` and `viewer` the rows exclude comment events whose `isInternal` is true (in `afterValue` or `beforeValue`) and every `case.rejected` row; `total` reflects the filtered count. Newest first. Read-only, no audit entry for the read.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/audit/case-audit.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { authHeader } from '../../helpers/auth-header';

describe('GET /cases/:id/audit', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  async function world() {
    const master = await seedCaseMasterData(ds);
    const dept = { departmentId: master.departmentId, entityId: master.entityId };
    const requester = await seedUserWithRole(ds, 'requester', dept);
    const rep = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Lina Lawyer' });
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const admin = await seedUserWithRole(ds, 'admin');
    const viewer = await seedUserWithRole(ds, 'viewer');
    const caseRow = await seedCase(ds, { ...master, requesterId: requester, status: 'In Progress', assignedLegalRepId: rep });
    const at = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();
    const log = async (action: string, actor: string, day: number, afterValue?: Record<string, unknown>) => {
      await logAuditEvent(ds, { actorId: actor, caseId: caseRow.id, action, afterValue });
      await ds.query(`UPDATE audit_log SET "createdAt" = $1 WHERE id = (SELECT id FROM audit_log WHERE "caseId" = $2 AND action = $3 ORDER BY "createdAt" DESC LIMIT 1)`, [at(day), caseRow.id, action]);
    };
    await log('case.submitted', requester, 1);
    await log('case.rejected', rep, 2, { reason: 'Conflict of interest' });
    await log('comment.created', rep, 3, { isInternal: true, body: 'INTERNAL LEGAL NOTE' });
    await log('comment.edited', rep, 4, { isInternal: true, body: 'INTERNAL EDIT' });
    await log('comment.deleted', rep, 5, { isInternal: true });
    await log('info_request.raised', rep, 6, { subject: 'Need info' });
    await ds.query(`INSERT INTO audit_log (id, "caseId", "actorId", action, "beforeValue", "afterValue") VALUES (gen_random_uuid(), $1, $2, 'comment.edited', $3, $4)`, [caseRow.id, rep, JSON.stringify({ isInternal: true, body: 'OLD INTERNAL' }), JSON.stringify({ isInternal: false, body: 'made public' })]);
    const publicEvent = await ds.query(`INSERT INTO audit_log (id, "caseId", "actorId", action, "afterValue") VALUES (gen_random_uuid(), $1, $2, 'comment.created', $3) RETURNING id`, [caseRow.id, requester, JSON.stringify({ isInternal: false, body: 'Visible comment' })]);
    return { caseRow, requester, rep, manager, admin, viewer, publicEvent: publicEvent[0].id as string };
  }

  const actionsOf = (res: { json: () => { items: Array<{ action: string }> } }) => res.json().items.map((item) => item.action);

  it.each([['admin', 'admin'], ['manager', 'legal_manager'], ['rep', 'legal_rep']] as const)('%s sees every row of the case, newest first, with names', async (who, role) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?pageSize=100`, headers: authHeader(app, w[who], role) });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(8);
    expect(actionsOf(res)).toContain('case.rejected');
    expect(JSON.stringify(res.json())).toContain('INTERNAL LEGAL NOTE');
    const rejected = res.json().items.find((item: { action: string }) => item.action === 'case.rejected');
    expect(rejected).toMatchObject({ actorName: 'Lina Lawyer', actorRole: 'legal_rep', caseReference: w.caseRow.referenceNumber });
    const times = res.json().items.map((item: { createdAt: string }) => item.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    await app.close();
  });

  it.each([['requester', 'requester'], ['viewer', 'viewer']] as const)('%s never sees internal comment events or the rejection reason', async (who, role) => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();

    const res = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?pageSize=100`, headers: authHeader(app, w[who], role) });

    expect(res.statusCode).toBe(200);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain('INTERNAL LEGAL NOTE');
    expect(text).not.toContain('INTERNAL EDIT');
    expect(text).not.toContain('OLD INTERNAL');
    expect(text).not.toContain('Conflict of interest');
    expect(actionsOf(res)).not.toContain('case.rejected');
    expect(actionsOf(res)).toContain('case.submitted');
    expect(actionsOf(res)).toContain('info_request.raised');
    expect(res.json().items.some((item: { id: string }) => item.id === w.publicEvent)).toBe(true);
    expect(res.json().total).toBe(res.json().items.length);
    await app.close();
  });

  it('paginates and filters by date', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const headers = authHeader(app, w.manager, 'legal_manager');

    const page = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?page=2&pageSize=3`, headers });
    const window = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?createdFrom=2026-01-02T00:00:00Z&createdTo=2026-01-03T23:59:59Z`, headers });
    const reversed = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit?createdFrom=2026-02-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z`, headers });

    expect(page.json()).toMatchObject({ total: 8, page: 2, pageSize: 3 });
    expect(page.json().items).toHaveLength(3);
    expect(actionsOf(window).sort()).toEqual(['case.rejected', 'comment.created']);
    expect(reversed.statusCode).toBe(400);
    await app.close();
  });

  it('answers 404 when the case is not visible to the caller (confidential, other department)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    await ds.query(`UPDATE cases SET "isConfidential" = true WHERE id = $1`, [w.caseRow.id]);
    const colleague = await seedUserWithRole(ds, 'requester', { departmentId: w.caseRow.departmentId, entityId: w.caseRow.entityId });
    const stranger = await seedCaseMasterData(ds);
    const outsider = await seedUserWithRole(ds, 'requester', { departmentId: stranger.departmentId, entityId: stranger.entityId });

    for (const [userId, role] of [[w.viewer, 'viewer'], [colleague, 'requester'], [outsider, 'requester']] as const) {
      const res = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit`, headers: authHeader(app, userId, role) });
      expect(res.statusCode).toBe(404);
    }
    const unknown = await app.inject({ method: 'GET', url: '/cases/6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e/audit', headers: authHeader(app, w.manager, 'legal_manager') });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it('requires authentication, validates the id and writes no audit entry for the read', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const w = await world();
    const [{ count: before }] = await ds.query(`SELECT COUNT(*)::int AS count FROM audit_log`);

    const anonymous = await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit` });
    const badId = await app.inject({ method: 'GET', url: '/cases/not-a-uuid/audit', headers: authHeader(app, w.manager, 'legal_manager') });
    await app.inject({ method: 'GET', url: `/cases/${w.caseRow.id}/audit`, headers: authHeader(app, w.manager, 'legal_manager') });

    const [{ count: after }] = await ds.query(`SELECT COUNT(*)::int AS count FROM audit_log`);
    expect(anonymous.statusCode).toBe(401);
    expect(badId.statusCode).toBe(400);
    expect(after).toBe(before);
    await app.close();
  });
});
```

(The audit rows are inserted directly or through `logAuditEvent` and re-timed with `UPDATE` so the ordering and date-window assertions are deterministic. If `audit_log.actorId` has a foreign key to `users`, the seeded users above satisfy it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/audit/case-audit.test.ts`
Expected: FAIL — `GET /cases/:id/audit` returns 404 "Route not found".

- [ ] **Step 3: Implement**

```typescript
// src/modules/audit/case-audit.service.ts
import type { DataSource } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { buildPaginatedResponse, paginationToSkipTake } from '../../shared/pagination';
import { serializeAuditRows } from './audit.serialize';

const LEGAL_ROLES = new Set(['admin', 'legal_manager', 'legal_rep']);

export async function listCaseAudit(
  dataSource: DataSource,
  actor: Actor,
  caseId: string,
  query: { page: number; pageSize: number; createdFrom?: Date; createdTo?: Date },
) {
  await getCaseById(dataSource, actor, caseId); // visibility gate: 404 when the caller cannot see the case

  const qb = dataSource.getRepository(AuditLog).createQueryBuilder('a').where('a."caseId" = :caseId', { caseId });
  if (query.createdFrom) qb.andWhere('a."createdAt" >= :createdFrom', { createdFrom: query.createdFrom });
  if (query.createdTo) qb.andWhere('a."createdAt" <= :createdTo', { createdTo: query.createdTo });
  if (!LEGAL_ROLES.has(actor.role)) {
    // Requesters and viewers must not learn legal-only content: internal notes
    // (their text is stored in the audit values) and the rejection reason.
    qb.andWhere(`a."action" != 'case.rejected'`);
    qb.andWhere(
      `NOT (a."action" LIKE 'comment.%' AND (COALESCE(a."afterValue"->>'isInternal', 'false') = 'true' OR COALESCE(a."beforeValue"->>'isInternal', 'false') = 'true'))`,
    );
  }

  const { skip, take } = paginationToSkipTake(query);
  const [rows, total] = await qb.orderBy('a."createdAt"', 'DESC').addOrderBy('a."id"', 'DESC').skip(skip).take(take).getManyAndCount();
  return buildPaginatedResponse(await serializeAuditRows(dataSource, rows), total, query);
}
```

In `audit.routes.ts` add (with `import { paginationQuerySchema } …`, `caseIdParamsSchema` from `cases.schemas`, and the Task 4 shape helpers):

```typescript
  typedApp.get('/cases/:id/audit', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Audit'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      querystring: paginationQuerySchema
        .extend({ createdFrom: z.coerce.date().optional(), createdTo: z.coerce.date().optional() })
        .refine(dateOrder, dateOrderMessage),
      response: { 200: auditListResponseSchema },
    },
  }, async (request) =>
    listCaseAudit(app.dataSource, {
      id: request.user.id, role: request.user.role, departmentId: request.user.departmentId,
      entityId: request.user.entityId, businessUnitId: request.user.businessUnitId,
    }, request.params.id, request.query));
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/audit && npx tsc --noEmit`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-08-case-audit-endpoint.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/modules/audit test/integration/modules/audit/case-audit.test.ts decisions.md decisions/frontend-integration/task-08-case-audit-endpoint.md
git commit -m "feat: GET /cases/:id/audit visible to every role that can see the case"
```

---

### Task 9: Mark all notifications read

**Files:**
- Modify: `src/modules/notifications/notifications.service.ts`, `notifications.routes.ts`, `notifications.schemas.ts`
- Test: `test/integration/modules/notifications/notifications-read-all.test.ts`

**Interfaces:**
- Produces: `markAllNotificationsRead(dataSource, userId): Promise<number>` and `PATCH /notifications/read-all` → `{ updated: number }`; marks the caller's unread rows read (`readAt = now()`), never touches other users' rows or rows already read (their `readAt` is preserved); idempotent (second call → `{ updated: 0 }`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/notifications-read-all.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedNotification } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('PATCH /notifications/read-all', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('marks every unread notification of the caller read and reports the count', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'one' });
    await seedNotification(ds, { userId, title: 'two' });
    await seedNotification(ds, { userId, title: 'three' });

    const res = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers: authHeader(app, userId, 'requester') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 3 });
    const list = await app.inject({ method: 'GET', url: '/notifications', headers: authHeader(app, userId, 'requester') });
    expect(list.json().unreadCount).toBe(0);
    expect(list.json().items.every((item: { isRead: boolean; readAt: string | null }) => item.isRead && item.readAt !== null)).toBe(true);
    await app.close();
  });

  it('is idempotent and keeps the first readAt of an already-read notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'legal_rep');
    const earlier = new Date('2026-01-01T10:00:00Z');
    await seedNotification(ds, { userId, title: 'already read', isRead: true, readAt: earlier });
    await seedNotification(ds, { userId, title: 'unread' });
    const headers = authHeader(app, userId, 'legal_rep');

    const first = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers });
    const second = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers });

    expect(first.json()).toEqual({ updated: 1 });
    expect(second.json()).toEqual({ updated: 0 });
    const [row] = await ds.query(`SELECT "readAt" FROM notifications WHERE title = 'already read'`);
    expect(new Date(row.readAt).toISOString()).toBe(earlier.toISOString());
    await app.close();
  });

  it('never touches another user\'s notifications', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const otherId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'mine' });
    await seedNotification(ds, { userId: otherId, title: 'theirs' });

    await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers: authHeader(app, userId, 'requester') });

    const [theirs] = await ds.query(`SELECT "isRead" FROM notifications WHERE title = 'theirs'`);
    expect(theirs.isRead).toBe(false);
    await app.close();
  });

  it('works with nothing to mark, for a viewer, and requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const empty = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers: authHeader(app, viewerId, 'viewer') });
    const anonymous = await app.inject({ method: 'PATCH', url: '/notifications/read-all' });

    expect(empty.json()).toEqual({ updated: 0 });
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/notifications-read-all.test.ts`
Expected: FAIL — the route does not exist (404, or a 400 from the `:id` route).

- [ ] **Step 3: Implement**

```typescript
// notifications.service.ts — add
export async function markAllNotificationsRead(dataSource: DataSource, userId: string): Promise<number> {
  const result = await dataSource
    .getRepository(AppNotification)
    .update({ userId, isRead: false }, { isRead: true, readAt: () => 'now()' });
  return result.affected ?? 0;
}
```

```typescript
// notifications.schemas.ts — add
export const markAllReadResponseSchema = z.object({ updated: z.number() });

// notifications.routes.ts — add (any position; the path cannot be confused with /notifications/:id/read)
  typedApp.patch('/notifications/read-all', {
    preHandler: [app.authenticate],
    schema: { tags: ['Notifications'], security: [{ bearerAuth: [] }], response: { 200: markAllReadResponseSchema } },
  }, async (request) => ({ updated: await markAllNotificationsRead(app.dataSource, request.user.id) }));
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/notifications && npx tsc --noEmit`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-09-mark-all-read.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add src/modules/notifications test/integration/modules/notifications/notifications-read-all.test.ts decisions.md decisions/frontend-integration/task-09-mark-all-read.md
git commit -m "feat: PATCH /notifications/read-all"
```

---

### Task 10: Audit coverage guard (test-only)

**Files:**
- Create: `test/integration/helpers/audit-manifest.ts`
- Modify: `test/integration/helpers/build-test-app.ts` (route registry + runtime check, test app only)
- Test: `test/integration/audit-coverage.test.ts`

**Interfaces:**
- Produces:
  - `AUDITED_ROUTES: Record<string, string>` (key `'METHOD /route/pattern'` → expected audit action(s) as documentation, e.g. `'POST /cases': 'case.submitted'`) and `EXEMPT_ROUTES: Record<string, string>` (key → written reason) in `audit-manifest.ts`
  - `getRegisteredMutatingRoutes(app): string[]` (keys of every registered `POST|PATCH|PUT|DELETE` route, from an `onRoute` hook added by `buildTestApp` before the routes load)
  - `buildTestApp(ds, { extraAuditedRoutes?: Record<string, string>, ... })` — a runtime `onSend` hook: for a mutating request whose route is in the audited map (the manifest plus `extraAuditedRoutes`) and whose response status is 2xx, count `audit_log` rows before the request (`onRequest`) and after the handler; if the count did not increase, replace the response with status 500 and body `{ error: { code: 'AUDIT_COVERAGE_MISSING', message: 'Route <key> succeeded without writing an audit entry' } }`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/audit-coverage.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from './helpers/test-data-source';
import { buildTestApp } from './helpers/build-test-app';
import { resetDatabase } from './helpers/reset-db';
import { seedUserWithRole } from './helpers/seed-user';
import { authHeader } from './helpers/auth-header';
import { AUDITED_ROUTES, EXEMPT_ROUTES, getRegisteredMutatingRoutes } from './helpers/audit-manifest';
import { logAuditEvent } from '../../src/modules/audit/audit.service';

describe('audit coverage guard', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('every mutating route is classified as audited or exempt, and the manifest has no stale entries', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const registered = new Set(getRegisteredMutatingRoutes(app));
    const classified = new Set([...Object.keys(AUDITED_ROUTES), ...Object.keys(EXEMPT_ROUTES)]);

    expect([...registered].filter((route) => !classified.has(route)), 'registered but not classified').toEqual([]);
    expect([...classified].filter((route) => !registered.has(route)), 'classified but no longer registered').toEqual([]);
    await app.close();
  });

  it('no route is both audited and exempt, and every exemption has a reason', () => {
    const both = Object.keys(AUDITED_ROUTES).filter((route) => route in EXEMPT_ROUTES);
    expect(both).toEqual([]);
    for (const [route, reason] of Object.entries(EXEMPT_ROUTES)) {
      expect(reason.trim().length, `${route} needs a written reason`).toBeGreaterThan(10);
    }
    for (const [route, action] of Object.entries(AUDITED_ROUTES)) {
      expect(action.trim().length, `${route} needs its expected audit action`).toBeGreaterThan(0);
    }
  });

  it('a classified route that succeeds without writing an audit row fails loudly', async () => {
    const app = buildTestApp(ds, { extraAuditedRoutes: { 'POST /__test/no-audit': 'none', 'POST /__test/with-audit': 'test.event' } });
    const actorId = await seedUserWithRole(ds, 'admin');
    app.register(async (instance) => {
      instance.post('/__test/no-audit', async () => ({ ok: true }));
      instance.post('/__test/with-audit', async () => {
        await logAuditEvent(instance.dataSource, { actorId, action: 'test.event' });
        return { ok: true };
      });
    });
    await app.ready();
    const headers = authHeader(app, actorId, 'admin');

    const missing = await app.inject({ method: 'POST', url: '/__test/no-audit', headers, payload: {} });
    const present = await app.inject({ method: 'POST', url: '/__test/with-audit', headers, payload: {} });

    expect(missing.statusCode).toBe(500);
    expect(missing.json().error.code).toBe('AUDIT_COVERAGE_MISSING');
    expect(present.statusCode).toBe(200);
    await app.close();
  });

  it('a failed (non-2xx) request on an audited route is not flagged, and exempt routes are never checked', async () => {
    const app = buildTestApp(ds, { extraAuditedRoutes: { 'POST /__test/fails': 'none' } });
    app.register(async (instance) => {
      instance.post('/__test/fails', async (_request, reply) => reply.status(409).send({ error: { code: 'CONFLICT', message: 'nope' } }));
    });
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');

    const failed = await app.inject({ method: 'POST', url: '/__test/fails', headers: authHeader(app, adminId, 'admin'), payload: {} });
    const exempt = await app.inject({ method: 'POST', url: '/auth/logout', payload: {} });

    expect(failed.statusCode).toBe(409);
    expect(exempt.statusCode).toBe(204);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/audit-coverage.test.ts`
Expected: FAIL — `Cannot find module './helpers/audit-manifest'`.

- [ ] **Step 3: Implement**

`test/integration/helpers/audit-manifest.ts` exports `AUDITED_ROUTES`, `EXEMPT_ROUTES` and `getRegisteredMutatingRoutes`. **Build the manifest by reading the real route registrations**, one entry per mutating route (the routes known today, with the audit actions their services write, are):

```typescript
export const EXEMPT_ROUTES: Record<string, string> = {
  'POST /auth/login': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'POST /auth/refresh': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'POST /auth/logout': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'POST /auth/change-password': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'PATCH /notifications/:id/read': 'Read state of a notification is not a business event.',
  'PATCH /notifications/read-all': 'Read state of notifications is not a business event.',
};

export const AUDITED_ROUTES: Record<string, string> = {
  'POST /cases': 'case.submitted',
  'PATCH /cases/:id': 'case.updated',
  'PATCH /cases/:id/priority': 'case.priority_changed',
  'PATCH /cases/:id/assign': 'case.assigned',
  'PATCH /cases/:id/accept': 'case.accepted',
  'PATCH /cases/:id/reject': 'case.rejected',
  'PATCH /cases/:id/close': 'case.closed',
  'PATCH /cases/:id/escalate': 'case.escalated | case.escalation_cleared',
  'POST /cases/:id/comments': 'comment.created',
  'PATCH /comments/:id': 'comment.edited',
  'DELETE /comments/:id': 'comment.deleted',
  'POST /cases/:id/documents': 'document.uploaded',
  'POST /documents/:id/versions': 'document.version_uploaded',
  'POST /information-requests/:id/attachments': 'document.uploaded',
  'DELETE /documents/:id': 'document.deleted',
  'POST /cases/:id/information-requests': 'info_request.raised',
  'POST /information-requests/:id/respond': 'info_request.answered',
  'POST /information-requests/:id/reopen': 'info_request.reopened',
  'POST /users': 'user.created',
  'PATCH /users/:id': 'user.updated',
  'PATCH /users/:id/role': 'user.role_changed',
  'PATCH /users/:id/activate': 'user.activated',
  'PATCH /users/:id/deactivate': 'user.deactivated',
  'PATCH /users/:id/reset-password': 'user.password_reset',
  // master data — add one entry per POST/PATCH route found in master-data.routes.ts and the
  // simple-resource registrations (entities, business-units, case-types, routing-rules,
  // departments, case-categories, closure-outcomes), each with its `<prefix>.created` / `<prefix>.updated` action
};
```

`getRegisteredMutatingRoutes(app)` reads a `WeakMap<FastifyInstance, Set<string>>` that `buildTestApp` fills from an `onRoute` hook (`method` may be a string or an array; keep only `POST`, `PATCH`, `PUT`, `DELETE`; key = `'METHOD ' + routeOptions.url`). Export the `WeakMap` setter used by `buildTestApp`.

In `buildTestApp`, immediately after `buildApp(...)` returns and before `ready()`:

```typescript
  const mutating = new Set<string>();
  registerMutatingRoutes(app, mutating);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) mutating.add(`${method} ${route.url}`);
    }
  });

  const audited = { ...AUDITED_ROUTES, ...options.extraAuditedRoutes };
  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return;
    const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM audit_log`);
    (request as unknown as { auditBefore?: number }).auditBefore = count;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const key = `${request.method} ${request.routeOptions?.url}`;
    const before = (request as unknown as { auditBefore?: number }).auditBefore;
    if (before === undefined || !(key in audited) || reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM audit_log`);
    if (count > before) return payload;
    reply.status(500).type('application/json');
    return JSON.stringify({ error: { code: 'AUDIT_COVERAGE_MISSING', message: `Route ${key} succeeded without writing an audit entry` } });
  });
```

A concurrent request can only hide a gap (another audit row appearing), never produce a false failure. The hooks live only in `buildTestApp`, never in `src/`.

- [ ] **Step 4: Run the guard, then the whole suite with the runtime check on**

Run: `npx vitest run test/integration/audit-coverage.test.ts`, then the full suite: `docker compose -f docker-compose.test.yml down -v && docker compose -f docker-compose.test.yml up -d` (wait a few seconds) and `npx vitest run > /tmp/full.txt 2>&1; grep -E "Test Files|Tests |FAIL|AUDIT_COVERAGE_MISSING" /tmp/full.txt`
Expected: the guard test passes. If the full suite surfaces `AUDIT_COVERAGE_MISSING` for a route, decide per route: (a) a real missing audit call → add it in the service with a test, or (b) a legitimate no-op → move the route to `EXEMPT_ROUTES` with a reason. Record every such finding in your report; a real gap is the point of this task.

- [ ] **Step 5: Commit**

Create `decisions/frontend-integration/task-10-audit-coverage-guard.md` and add one bullet to the top of the `## frontend-integration` section in `decisions.md`.

```bash
git add test/integration/helpers/audit-manifest.ts test/integration/helpers/build-test-app.ts test/integration/audit-coverage.test.ts decisions.md decisions/frontend-integration/task-10-audit-coverage-guard.md
git commit -m "test: guard that every mutating route writes an audit entry"
```

(Include any `src/` change that closed a real audit gap found in Step 4, with its own test, in this same commit and say so in the decision file.)

---

## Final verification

After Task 10, run the whole backend suite on a genuinely fresh test container (the test Postgres uses `tmpfs`, so only a recreated container guarantees empty state) and the typecheck:

```bash
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up -d
sleep 6
npx vitest run > /tmp/full.txt 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/full.txt
npx tsc --noEmit
```

Expected: all test files pass (previously 467 passed / 2 skipped; this plan adds roughly 110 more tests), `tsc` clean. Then boot the dev server against the dev database (`pnpm migration:run` first) and check manually: `POST /auth/login` sets two `HttpOnly` cookies, `GET /auth/me` works from the cookie, and a browser request from the allowed origin passes CORS.
