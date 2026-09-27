# Phase 1: Foundation, Auth & Master Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the LCMS backend platform: project scaffolding, config/DB/docker infra, error handling, auth (login/refresh/logout), users + RBAC, admin-configurable master data, and the audit trail — a working, testable base for every later phase.

**Architecture:** Feature-based modular monolith on Fastify. Each domain (`auth`, `users`, `master-data`, `audit`) is a self-contained plugin: entities, Zod schemas, service, routes. Cross-cutting pieces (`config`, `db`, `plugins`, `shared`) hold nothing domain-specific.

**Tech Stack:** Node.js 22 + TypeScript, Fastify, Zod + fastify-type-provider-zod, TypeORM + PostgreSQL (migrations only, no `synchronize`), argon2, @fastify/jwt, pnpm, Vitest with integration tests against a real Postgres.

**Spec:** `docs/superpowers/specs/2026-09-27-lcms-backend-design.md`

## Global Constraints

- Node.js 22, TypeScript throughout, pnpm as package manager.
- Fastify + Zod (`fastify-type-provider-zod`) for every request/response schema — no untyped route handlers.
- TypeORM migrations are the only way schema reaches any environment; `synchronize: true` is never used.
- No self-registration — only admin-created accounts (AC-12).
- Roles live only in `roles`/`user_roles` tables, never as a column on `users` (AC-02); exactly one active role per user, enforced by a DB unique constraint (VC-16).
- Passwords hashed with argon2, never logged in plaintext anywhere (SE-01).
- Authorization is enforced server-side in service/repository code regardless of what the UI would show (AC-03, app-layer decision from the spec).
- A user can never delete/deactivate their own account (VC-18, PR-25).
- Master-data changes are effective immediately for subsequent requests — no caching layer to invalidate (DM-09).
- Every error response has the shape `{ error: { code, message, details? } }`, produced by one central Fastify error handler.

## Review Focus

- Login against a deactivated user must fail even with the correct password — the `isActive` check has to run in the login path itself, not just in list/read filtering.
- A refresh token that was already rotated (used once) must be rejected if presented again — replay of an old refresh token should not re-issue new tokens.
- Email uniqueness on user creation must be case-insensitive (`Admin@x.com` vs `admin@x.com` should collide), since Postgres unique constraints are case-sensitive by default.
- Concurrent role-assignment requests for the same user must never crash and must never leave two active role rows behind — implemented as an atomic `INSERT ... ON CONFLICT (userId) DO UPDATE` (TypeORM `upsert`), not a read-then-write race, so the DB's unique constraint on `user_roles.userId` is enforced by construction rather than caught after the fact.
- Deactivating a master-data record that's still referenced elsewhere (e.g. a department with users assigned to it) must soft-deactivate (`isActive=false`), never hard-delete, so FK integrity and history are preserved.

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/server.ts` (placeholder entrypoint, filled in Task 7)
- Create: `.gitignore` (extend existing empty file)

**Interfaces:**
- Produces: pnpm scripts `dev`, `build`, `test`, `test:integration`, `migration:run`, `migration:generate`.

- [ ] **Step 1: Initialize package.json**

```bash
pnpm init
pnpm add fastify @fastify/jwt fastify-type-provider-zod zod typeorm pg reflect-metadata argon2 dotenv
pnpm add -D typescript tsx @types/node vitest @vitest/coverage-v8
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Add pnpm scripts to package.json**

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "migration:generate": "typeorm-ts-node-commonjs migration:generate -d src/db/data-source.ts",
    "migration:run": "typeorm-ts-node-commonjs migration:run -d src/db/data-source.ts",
    "migration:revert": "typeorm-ts-node-commonjs migration:revert -d src/db/data-source.ts"
  }
}
```

- [ ] **Step 4: Write vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
```

- [ ] **Step 5: Write .env.example**

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://lcms:lcms@localhost:5432/lcms_dev
JWT_ACCESS_SECRET=change-me-to-a-32-plus-character-secret-value
JWT_ACCESS_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_DAYS=30
```

- [ ] **Step 6: Write placeholder src/server.ts**

```typescript
console.log('LCMS backend scaffold — server bootstrap comes in Task 7');
```

- [ ] **Step 7: Extend .gitignore**

```
node_modules/
dist/
.env
*.log
coverage/
```

- [ ] **Step 8: Verify install and typecheck**

Run: `pnpm install && pnpm exec tsc --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .env.example src/server.ts .gitignore
git commit -m "chore: project scaffolding (fastify, typeorm, zod, vitest)"
```

---

## Task 2: Config/env validation

**Files:**
- Create: `src/config/env.ts`
- Test: `test/unit/config/env.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?: NodeJS.ProcessEnv): Env`, `type Env` with fields `NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `REFRESH_TOKEN_EXPIRES_DAYS`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/config/env.test.ts
import { describe, it, expect, vi } from 'vitest';
import { loadEnv } from '../../../src/config/env';

describe('loadEnv', () => {
  const valid = {
    NODE_ENV: 'test',
    PORT: '4000',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_ACCESS_EXPIRES_IN: '15m',
    REFRESH_TOKEN_EXPIRES_DAYS: '30',
  };

  it('parses and coerces a valid environment', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('test');
  });

  it('exits the process when a required var is missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { DATABASE_URL, ...missing } = valid;
    loadEnv(missing as unknown as NodeJS.ProcessEnv);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/config/env.test.ts`
Expected: FAIL — `Cannot find module '../../../src/config/env'`

- [ ] **Step 3: Write src/config/env.ts**

```typescript
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
    throw new Error('unreachable');
  }
  return parsed.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/config/env.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts test/unit/config/env.test.ts
git commit -m "feat: validated env config loader"
```

---

## Task 3: Docker Compose dev & test infrastructure

**Files:**
- Modify: `docker-compose.dev.yml`
- Create: `docker-compose.test.yml`

**Interfaces:**
- Produces: dev Postgres on `localhost:5432` (db `lcms_dev`), MinIO on `9000`/console `9001`, MailHog SMTP on `1025`/UI `8025`; test Postgres on `localhost:5433` (db `lcms_test`).

- [ ] **Step 1: Write docker-compose.dev.yml**

```yaml
version: "3.9"
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: lcms
      POSTGRES_PASSWORD: lcms
      POSTGRES_DB: lcms_dev
    ports:
      - "5432:5432"
    volumes:
      - lcms_pg_dev:/var/lib/postgresql/data

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: lcms
      MINIO_ROOT_PASSWORD: lcms12345
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - lcms_minio_dev:/data

  mailhog:
    image: mailhog/mailhog:latest
    ports:
      - "1025:1025"
      - "8025:8025"

volumes:
  lcms_pg_dev:
  lcms_minio_dev:
```

- [ ] **Step 2: Write docker-compose.test.yml**

```yaml
version: "3.9"
services:
  postgres-test:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: lcms
      POSTGRES_PASSWORD: lcms
      POSTGRES_DB: lcms_test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
```

- [ ] **Step 3: Verify dev stack starts**

Run: `docker compose -f docker-compose.dev.yml up -d && docker compose -f docker-compose.dev.yml ps`
Expected: all three services show `running`/`healthy`.

- [ ] **Step 4: Verify test stack starts**

Run: `docker compose -f docker-compose.test.yml up -d && docker compose -f docker-compose.test.yml ps`
Expected: `postgres-test` running.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.dev.yml docker-compose.test.yml
git commit -m "chore: docker compose for dev (postgres/minio/mailhog) and test (postgres) infra"
```

---

## Task 4: TypeORM DataSource & migration tooling

**Files:**
- Create: `src/db/data-source.ts`
- Create: `test/integration/helpers/test-data-source.ts`

**Interfaces:**
- Consumes: `Env` from Task 2 (`src/config/env.ts`).
- Produces: `AppDataSource: DataSource` (app), `buildTestDataSource(): DataSource` (integration tests, points at port 5433).

- [ ] **Step 1: Write src/db/data-source.ts**

```typescript
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadEnv } from '../config/env';

const env = loadEnv();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  synchronize: false,
  logging: env.NODE_ENV === 'development',
  entities: ['src/modules/**/entities/*.entity.ts', 'dist/modules/**/entities/*.entity.js'],
  migrations: ['src/db/migrations/*.ts', 'dist/db/migrations/*.js'],
});
```

- [ ] **Step 2: Write test/integration/helpers/test-data-source.ts**

```typescript
import 'reflect-metadata';
import { DataSource } from 'typeorm';

export function buildTestDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: 'postgres://lcms:lcms@localhost:5433/lcms_test',
    synchronize: false,
    logging: false,
    entities: ['src/modules/**/entities/*.entity.ts'],
    migrations: ['src/db/migrations/*.ts'],
  });
}
```

- [ ] **Step 3: Verify DataSource connects (manual check, no migrations yet)**

Run: `pnpm exec tsx -e "import('./src/db/data-source').then(m => m.AppDataSource.initialize()).then(() => { console.log('connected'); process.exit(0); })"`
Expected: prints `connected` (requires `docker compose -f docker-compose.dev.yml up -d` running from Task 3, and a `.env` copied from `.env.example` with a matching `DATABASE_URL`).

- [ ] **Step 4: Commit**

```bash
git add src/db/data-source.ts test/integration/helpers/test-data-source.ts
git commit -m "feat: typeorm data sources for app and integration tests"
```

---

## Task 5: Shared error types

**Files:**
- Create: `src/shared/errors.ts`
- Test: `test/unit/shared/errors.test.ts`

**Interfaces:**
- Produces: `AppError` (base, has `statusCode`, `code`, `message`, `details?`), `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `UnauthorizedError` — all extend `AppError`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/shared/errors.test.ts
import { describe, it, expect } from 'vitest';
import { AppError, NotFoundError, ForbiddenError, ValidationError, ConflictError, UnauthorizedError } from '../../../src/shared/errors';

describe('AppError hierarchy', () => {
  it('NotFoundError carries 404 and a code', () => {
    const e = new NotFoundError('Case not found');
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('Case not found');
  });

  it('ForbiddenError carries 403', () => {
    expect(new ForbiddenError('nope').statusCode).toBe(403);
  });

  it('ValidationError carries 400 and optional details', () => {
    const e = new ValidationError('bad input', { field: 'title' });
    expect(e.statusCode).toBe(400);
    expect(e.details).toEqual({ field: 'title' });
  });

  it('ConflictError carries 409', () => {
    expect(new ConflictError('duplicate').statusCode).toBe(409);
  });

  it('UnauthorizedError carries 401', () => {
    expect(new UnauthorizedError('bad token').statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/shared/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/shared/errors.ts**

```typescript
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/shared/errors.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors.ts test/unit/shared/errors.test.ts
git commit -m "feat: typed AppError hierarchy"
```

---

## Task 6: RBAC helper

**Files:**
- Create: `src/shared/rbac.ts`
- Test: `test/unit/shared/rbac.test.ts`

**Interfaces:**
- Consumes: nothing yet (the `request.user` shape it expects is defined here and implemented by the auth plugin in Task 10).
- Produces: `type AuthenticatedUser = { id: string; role: string; departmentId: string | null; entityId: string | null; businessUnitId: string | null }`, `requireRole(allowed: string[]): (request, reply) => void` (Fastify preHandler — throws `ForbiddenError` if `request.user.role` isn't in `allowed`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/shared/rbac.test.ts
import { describe, it, expect } from 'vitest';
import { requireRole } from '../../../src/shared/rbac';
import { ForbiddenError } from '../../../src/shared/errors';

function fakeRequest(role: string) {
  return { user: { id: 'u1', role, departmentId: null, entityId: null, businessUnitId: null } } as any;
}

describe('requireRole', () => {
  it('allows a request whose role is in the allow-list', () => {
    const handler = requireRole(['admin', 'legal_manager']);
    expect(() => handler(fakeRequest('admin'), {} as any)).not.toThrow();
  });

  it('throws ForbiddenError for a role not in the allow-list', () => {
    const handler = requireRole(['admin']);
    expect(() => handler(fakeRequest('requester'), {} as any)).toThrow(ForbiddenError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/shared/rbac.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/shared/rbac.ts**

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ForbiddenError } from './errors';

export type AuthenticatedUser = {
  id: string;
  role: string;
  departmentId: string | null;
  entityId: string | null;
  businessUnitId: string | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

export function requireRole(allowed: string[]) {
  return function (request: FastifyRequest, _reply: FastifyReply): void {
    if (!allowed.includes(request.user.role)) {
      throw new ForbiddenError(`Role '${request.user.role}' is not permitted to perform this action`);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/shared/rbac.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/rbac.ts test/unit/shared/rbac.test.ts
git commit -m "feat: requireRole RBAC preHandler and AuthenticatedUser type"
```

---

## Task 7: Fastify app assembly, error handler & health check

**Files:**
- Create: `src/plugins/error-handler.ts`
- Create: `src/app.ts`
- Modify: `src/server.ts`
- Create: `test/integration/helpers/build-test-app.ts`
- Test: `test/integration/health.test.ts`

**Interfaces:**
- Consumes: `AppError` from Task 5, `Env`/`loadEnv` from Task 2. Does NOT import `AppDataSource` directly — the DataSource is passed in, so tests can substitute the test database.
- Produces: `buildApp(dataSource: DataSource): FastifyInstance` (decorates `app.dataSource`, no other DB side effects), `registerErrorHandler(app): void`. Every later module's routes read `app.dataSource`, never `import { AppDataSource }` — this is what keeps a route registered against the test app talking to the test Postgres instead of accidentally opening a second connection to dev.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/health.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from './helpers/test-data-source';
import { buildTestApp } from './helpers/build-test-app';

describe('GET /health', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('returns ok status', async () => {
    const app = buildTestApp(ds);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/health.test.ts`
Expected: FAIL — `Cannot find module './helpers/build-test-app'`

- [ ] **Step 3: Write src/plugins/error-handler.ts**

```typescript
import type { FastifyInstance, FastifyError } from 'fastify';
import { AppError } from '../shared/errors';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }

    if (error.validation) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.validation },
      });
      return;
    }

    app.log.error(error);
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });
}
```

- [ ] **Step 4: Write src/app.ts**

```typescript
import Fastify, { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerErrorHandler } from './plugins/error-handler';

declare module 'fastify' {
  interface FastifyInstance {
    dataSource: DataSource;
  }
}

export function buildApp(dataSource: DataSource): FastifyInstance {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  app.decorate('dataSource', dataSource);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
```

- [ ] **Step 5: Write test/integration/helpers/build-test-app.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { buildApp } from '../../../src/app';

export function buildTestApp(dataSource: DataSource): FastifyInstance {
  return buildApp(dataSource);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:integration test/integration/health.test.ts`
Expected: PASS (1 test)

- [ ] **Step 7: Write real src/server.ts entrypoint**

```typescript
import 'reflect-metadata';
import { buildApp } from './app';
import { AppDataSource } from './db/data-source';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  await AppDataSource.initialize();
  const app = buildApp(AppDataSource);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await AppDataSource.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 8: Verify the real server boots**

Run: `docker compose -f docker-compose.dev.yml up -d && cp .env.example .env && pnpm dev` then in another terminal `curl http://localhost:3000/health`
Expected: `{"status":"ok"}` (stop the dev server with Ctrl+C afterward)

- [ ] **Step 9: Commit**

```bash
git add src/plugins/error-handler.ts src/app.ts src/server.ts test/integration/helpers/build-test-app.ts test/integration/health.test.ts
git commit -m "feat: fastify app assembly, central error handler, health check"
```

---

## Task 8: Roles, users, user_roles & refresh_tokens schema

**Files:**
- Create: `src/modules/users/entities/role.entity.ts`
- Create: `src/modules/users/entities/user.entity.ts`
- Create: `src/modules/users/entities/user-role.entity.ts`
- Create: `src/modules/auth/entities/refresh-token.entity.ts`
- Create: `src/db/migrations/1700000001000-create-users-and-roles.ts`
- Test: `test/integration/db/users-schema.test.ts`

**Interfaces:**
- Produces: `Role { id, name }`, `User { id, fullName, email, passwordHash, designation, phone, departmentId, entityId, businessUnitId, isActive, createdAt, updatedAt }`, `UserRole { id, userId (unique), roleId, assignedBy, assignedAt }`, `RefreshToken { id, userId, tokenHash, expiresAt, revokedAt, createdAt }`. Seeds 5 roles: `admin`, `legal_manager`, `legal_rep`, `requester`, `viewer`.

- [ ] **Step 1: Write entities**

```typescript
// src/modules/users/entities/role.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

export const ROLE_NAMES = ['admin', 'legal_manager', 'legal_rep', 'requester', 'viewer'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: RoleName;
}
```

```typescript
// src/modules/users/entities/user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  fullName!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'varchar', nullable: true })
  designation!: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  entityId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  businessUnitId!: string | null;

  @Column({ default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
```

```typescript
// src/modules/users/entities/user-role.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('user_roles')
export class UserRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  userId!: string;

  @Column({ type: 'uuid' })
  roleId!: string;

  @Column({ type: 'uuid', nullable: true })
  assignedBy!: string | null;

  @CreateDateColumn()
  assignedAt!: Date;
}
```

```typescript
// src/modules/auth/entities/refresh-token.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column()
  tokenHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
```

- [ ] **Step 2: Write the migration**

```typescript
// src/db/migrations/1700000001000-create-users-and-roles.ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateUsersAndRoles1700000001000 implements MigrationInterface {
  name = 'CreateUsersAndRoles1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.createTable(
      new Table({
        name: 'roles',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'name', type: 'varchar', isUnique: true },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'users',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'fullName', type: 'varchar' },
          { name: 'email', type: 'varchar', isUnique: true },
          { name: 'passwordHash', type: 'varchar' },
          { name: 'designation', type: 'varchar', isNullable: true },
          { name: 'phone', type: 'varchar', isNullable: true },
          { name: 'departmentId', type: 'uuid', isNullable: true },
          { name: 'entityId', type: 'uuid', isNullable: true },
          { name: 'businessUnitId', type: 'uuid', isNullable: true },
          { name: 'isActive', type: 'boolean', default: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'user_roles',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'userId', type: 'uuid', isUnique: true },
          { name: 'roleId', type: 'uuid' },
          { name: 'assignedBy', type: 'uuid', isNullable: true },
          { name: 'assignedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'user_roles',
      new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'CASCADE' }),
    );
    await queryRunner.createForeignKey(
      'user_roles',
      new TableForeignKey({ columnNames: ['roleId'], referencedTableName: 'roles', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'refresh_tokens',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'userId', type: 'uuid' },
          { name: 'tokenHash', type: 'varchar' },
          { name: 'expiresAt', type: 'timestamptz' },
          { name: 'revokedAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'refresh_tokens',
      new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'CASCADE' }),
    );

    await queryRunner.query(
      `INSERT INTO roles (name) VALUES ('admin'), ('legal_manager'), ('legal_rep'), ('requester'), ('viewer')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('refresh_tokens');
    await queryRunner.dropTable('user_roles');
    await queryRunner.dropTable('users');
    await queryRunner.dropTable('roles');
  }
}
```

- [ ] **Step 3: Write the failing test**

```typescript
// test/integration/db/users-schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestDataSource } from '../helpers/test-data-source';
import type { DataSource } from 'typeorm';

describe('users/roles schema', () => {
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

  it('seeds exactly the five required roles', async () => {
    const rows = await ds.query('SELECT name FROM roles ORDER BY name');
    expect(rows.map((r: { name: string }) => r.name)).toEqual([
      'admin',
      'legal_manager',
      'legal_rep',
      'requester',
      'viewer',
    ]);
  });

  it('rejects a second active role row for the same user (VC-16)', async () => {
    const [role] = await ds.query(`SELECT id FROM roles WHERE name = 'requester'`);
    const [user] = await ds.query(
      `INSERT INTO users ("fullName", email, "passwordHash") VALUES ('Test User', 'dup@test.local', 'x') RETURNING id`,
    );
    await ds.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [user.id, role.id]);

    await expect(
      ds.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [user.id, role.id]),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `docker compose -f docker-compose.test.yml up -d && pnpm test:integration test/integration/db/users-schema.test.ts`
Expected: FAIL — tables don't exist / migration file not found by the runner yet (module resolution error until entities compile).

- [ ] **Step 5: Run migrations against the test DB and verify test passes**

Run: `pnpm test:integration test/integration/db/users-schema.test.ts`
Expected: PASS (2 tests) — `beforeAll` runs the migration itself, so no separate manual step is needed.

- [ ] **Step 6: Commit**

```bash
git add src/modules/users/entities src/modules/auth/entities src/db/migrations/1700000001000-create-users-and-roles.ts test/integration/db/users-schema.test.ts
git commit -m "feat: users/roles/user_roles/refresh_tokens schema with seeded roles"
```

---

## Task 9: Password hashing utility

**Files:**
- Create: `src/shared/password.ts`
- Test: `test/unit/shared/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(hash: string, plain: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/shared/password.test.ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/shared/password';

describe('password hashing', () => {
  it('verifies a correct password against its hash', async () => {
    const hash = await hashPassword('Sup3rSecret!');
    await expect(verifyPassword(hash, 'Sup3rSecret!')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Sup3rSecret!');
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('never stores the plaintext password in the hash output', async () => {
    const hash = await hashPassword('Sup3rSecret!');
    expect(hash).not.toContain('Sup3rSecret!');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/shared/password.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/shared/password.ts**

```typescript
import argon2 from 'argon2';

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/shared/password.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/password.ts test/unit/shared/password.test.ts
git commit -m "feat: argon2 password hashing utility"
```

---

## Task 10: Admin seed script

**Files:**
- Create: `src/db/seed-admin.ts`
- Modify: `package.json` (add `seed:admin` script)
- Test: `test/integration/db/seed-admin.test.ts`

**Interfaces:**
- Consumes: `hashPassword` (Task 9), `User`/`Role`/`UserRole` entities (Task 8).
- Produces: `seedAdmin(dataSource: DataSource, options: { email: string; password: string; fullName?: string }): Promise<void>` (exported, testable); a `main()` CLI wrapper that reads `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_FULL_NAME` from `process.env` and calls it, guarded by `require.main === module` equivalent so importing the file in tests doesn't run it.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/db/seed-admin.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { seedAdmin } from '../../../src/db/seed-admin';

describe('seedAdmin', () => {
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

  it('creates a user with the admin role assigned', async () => {
    await seedAdmin(ds, { email: 'Admin@Test.local', password: 'InitialPass123!', fullName: 'Root Admin' });

    const [user] = await ds.query(`SELECT id, email, "isActive" FROM users WHERE email = $1`, ['admin@test.local']);
    expect(user).toBeDefined();
    expect(user.isActive).toBe(true);

    const [assignment] = await ds.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur."roleId" WHERE ur."userId" = $1`,
      [user.id],
    );
    expect(assignment.name).toBe('admin');
  });

  it('is idempotent — running it again for the same email does not throw or duplicate', async () => {
    await expect(
      seedAdmin(ds, { email: 'admin@test.local', password: 'Different123!' }),
    ).resolves.not.toThrow();

    const rows = await ds.query(`SELECT id FROM users WHERE email = $1`, ['admin@test.local']);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/db/seed-admin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/db/seed-admin.ts**

```typescript
import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../shared/password';
import { User } from '../modules/users/entities/user.entity';
import { Role } from '../modules/users/entities/role.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';

export async function seedAdmin(
  dataSource: DataSource,
  options: { email: string; password: string; fullName?: string },
): Promise<void> {
  const email = options.email.toLowerCase();
  const userRepo = dataSource.getRepository(User);
  const roleRepo = dataSource.getRepository(Role);
  const userRoleRepo = dataSource.getRepository(UserRole);

  const existing = await userRepo.findOne({ where: { email } });
  if (existing) {
    return;
  }

  const adminRole = await roleRepo.findOneOrFail({ where: { name: 'admin' } });
  const passwordHash = await hashPassword(options.password);
  const user = await userRepo.save(
    userRepo.create({ fullName: options.fullName ?? 'System Administrator', email, passwordHash, isActive: true }),
  );
  await userRoleRepo.save(userRoleRepo.create({ userId: user.id, roleId: adminRole.id }));
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('./data-source');
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set');
    process.exit(1);
  }
  await AppDataSource.initialize();
  await seedAdmin(AppDataSource, { email, password, fullName: process.env.ADMIN_FULL_NAME });
  console.log(`Admin user ready: ${email.toLowerCase()}`);
  await AppDataSource.destroy();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:integration test/integration/db/seed-admin.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the pnpm script**

```json
{
  "scripts": {
    "seed:admin": "tsx src/db/seed-admin.ts"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/db/seed-admin.ts package.json test/integration/db/seed-admin.test.ts
git commit -m "feat: idempotent admin user seed script"
```

---

## Task 11: JWT plugin & request.user population

**Files:**
- Create: `src/plugins/auth.ts`
- Modify: `src/app.ts`
- Test: `test/integration/plugins/auth.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 2), `AuthenticatedUser` type (Task 6).
- Produces: Fastify decorator `authenticate` (a `preHandler` any protected route attaches) that verifies the `Authorization: Bearer <jwt>` header and sets `request.user`; helper `signAccessToken(payload: AuthenticatedUser): string` used later by the login endpoint.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/plugins/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { buildTestApp } from '../helpers/build-test-app';

describe('authenticate preHandler', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('rejects a request with no Authorization header', async () => {
    const app = buildTestApp(ds);
    app.get('/protected', { preHandler: app.authenticate }, async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('accepts a request with a valid access token and populates request.user', async () => {
    const app = buildTestApp(ds);
    app.get('/protected', { preHandler: app.authenticate }, async (request) => ({ userId: request.user.id }));
    await app.ready();

    const token = app.signAccessToken({
      id: 'user-1',
      role: 'admin',
      departmentId: null,
      entityId: null,
      businessUnitId: null,
    });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'user-1' });

    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/plugins/auth.test.ts`
Expected: FAIL — `app.authenticate is not a function`

- [ ] **Step 3: Write src/plugins/auth.ts**

```typescript
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
```

- [ ] **Step 4: Register the plugin in src/app.ts**

```typescript
// src/app.ts — add near the top with the other imports
import authPlugin from './plugins/auth';

// inside buildApp(), after registerErrorHandler(app):
app.register(authPlugin);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:integration test/integration/plugins/auth.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/plugins/auth.ts src/app.ts test/integration/plugins/auth.test.ts
git commit -m "feat: JWT auth plugin (authenticate preHandler, signAccessToken)"
```

---

## Task 12: Login endpoint

**Files:**
- Create: `src/modules/auth/auth.service.ts`
- Create: `src/modules/auth/auth.schemas.ts`
- Create: `src/modules/auth/auth.routes.ts`
- Modify: `src/app.ts` (register `authRoutes`)
- Test: `test/integration/modules/auth/login.test.ts`

**Interfaces:**
- Consumes: `verifyPassword` (Task 9), `User`/`Role`/`UserRole` entities (Task 8), `RefreshToken` entity (Task 8), `app.dataSource`/`app.signAccessToken` (Tasks 7/11), `UnauthorizedError` (Task 5), `AuthenticatedUser` (Task 6).
- Produces: `hashToken(token): string`, `generateOpaqueToken(): string`, `loadAuthenticatedUser(dataSource, user): Promise<AuthenticatedUser>`, `issueRefreshToken(dataSource, userId, expiresInDays): Promise<string>`, `login(dataSource, refreshTokenExpiresDays, email, password): Promise<{ user, refreshToken }>` — all consumed again by Tasks 13/14.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/auth/login.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedAdmin } from '../../../../src/db/seed-admin';

describe('POST /auth/login', () => {
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
    await ds.query('DELETE FROM refresh_tokens');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('returns access + refresh tokens for correct credentials', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user.role).toBe('admin');

    await app.close();
  });

  it('rejects an incorrect password', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'wrong-password' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects login for a deactivated user even with the correct password', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    await ds.query(`UPDATE users SET "isActive" = false WHERE email = 'admin@lcms.local'`);
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a malformed email with a validation error', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email', password: 'whatever' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/auth/login.test.ts`
Expected: FAIL — `/auth/login` route doesn't exist (404).

- [ ] **Step 3: Write src/modules/auth/auth.service.ts**

```typescript
import crypto from 'node:crypto';
import type { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/role.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { verifyPassword } from '../../shared/password';
import { UnauthorizedError } from '../../shared/errors';
import type { AuthenticatedUser } from '../../shared/rbac';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function loadAuthenticatedUser(dataSource: DataSource, user: User): Promise<AuthenticatedUser> {
  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId: user.id } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });
  return {
    id: user.id,
    role: role.name,
    departmentId: user.departmentId,
    entityId: user.entityId,
    businessUnitId: user.businessUnitId,
  };
}

export async function issueRefreshToken(
  dataSource: DataSource,
  userId: string,
  expiresInDays: number,
): Promise<string> {
  const repo = dataSource.getRepository(RefreshToken);
  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  await repo.save(repo.create({ userId, tokenHash: hashToken(token), expiresAt }));
  return token;
}

export async function login(
  dataSource: DataSource,
  refreshTokenExpiresDays: number,
  email: string,
  password: string,
): Promise<{ user: AuthenticatedUser; refreshToken: string }> {
  const user = await dataSource.getRepository(User).findOne({ where: { email: email.toLowerCase() } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const authenticatedUser = await loadAuthenticatedUser(dataSource, user);
  const refreshToken = await issueRefreshToken(dataSource, user.id, refreshTokenExpiresDays);
  return { user: authenticatedUser, refreshToken };
}
```

- [ ] **Step 4: Write src/modules/auth/auth.schemas.ts**

```typescript
import { z } from 'zod';

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const sessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({
    id: z.string(),
    role: z.string(),
    departmentId: z.string().nullable(),
    entityId: z.string().nullable(),
    businessUnitId: z.string().nullable(),
  }),
});
```

- [ ] **Step 5: Write src/modules/auth/auth.routes.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadEnv } from '../../config/env';
import { login } from './auth.service';
import { loginBodySchema, sessionResponseSchema } from './auth.schemas';

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
}
```

- [ ] **Step 6: Register the routes in src/app.ts**

```typescript
// src/app.ts — add import
import authRoutes from './modules/auth/auth.routes';

// inside buildApp(dataSource), after app.register(authPlugin):
app.register(authRoutes);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/auth/login.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.schemas.ts src/modules/auth/auth.routes.ts src/app.ts test/integration/modules/auth/login.test.ts
git commit -m "feat: POST /auth/login with access+refresh token issuance"
```

---

## Task 13: Refresh token rotation endpoint

**Files:**
- Modify: `src/modules/auth/auth.service.ts` (add `refreshSession`)
- Modify: `src/modules/auth/auth.schemas.ts` (add `refreshBodySchema`)
- Modify: `src/modules/auth/auth.routes.ts` (add `POST /auth/refresh`)
- Test: `test/integration/modules/auth/refresh.test.ts`

**Interfaces:**
- Consumes: everything from Task 12.
- Produces: `refreshSession(dataSource, refreshTokenExpiresDays, presentedToken): Promise<{ user, refreshToken }>` — rotates (revokes the presented token, issues a new one); rejects if the token is unknown, already revoked, or expired.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/auth/refresh.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedAdmin } from '../../../../src/db/seed-admin';

describe('POST /auth/refresh', () => {
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
    await ds.query('DELETE FROM refresh_tokens');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('issues a new token pair for a valid refresh token', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(refreshToken);

    await app.close();
  });

  it('rejects reuse of an already-rotated refresh token (replay protection)', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an unknown refresh token', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'not-a-real-token' } });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/auth/refresh.test.ts`
Expected: FAIL — `/auth/refresh` route doesn't exist (404).

- [ ] **Step 3: Add refreshSession to src/modules/auth/auth.service.ts**

```typescript
export async function refreshSession(
  dataSource: DataSource,
  refreshTokenExpiresDays: number,
  presentedToken: string,
): Promise<{ user: AuthenticatedUser; refreshToken: string }> {
  const repo = dataSource.getRepository(RefreshToken);
  const existing = await repo.findOne({ where: { tokenHash: hashToken(presentedToken) } });

  if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  existing.revokedAt = new Date();
  await repo.save(existing);

  const user = await dataSource.getRepository(User).findOne({ where: { id: existing.userId } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const authenticatedUser = await loadAuthenticatedUser(dataSource, user);
  const refreshToken = await issueRefreshToken(dataSource, user.id, refreshTokenExpiresDays);
  return { user: authenticatedUser, refreshToken };
}
```

- [ ] **Step 4: Add refreshBodySchema to src/modules/auth/auth.schemas.ts**

```typescript
export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});
```

- [ ] **Step 5: Add the route in src/modules/auth/auth.routes.ts**

```typescript
// add to imports
import { refreshSession } from './auth.service';
import { refreshBodySchema } from './auth.schemas';

// add inside authRoutes, after the /auth/login route
typedApp.post('/auth/refresh', {
  schema: { body: refreshBodySchema, response: { 200: sessionResponseSchema } },
}, async (request) => {
  const { user, refreshToken } = await refreshSession(app.dataSource, env.REFRESH_TOKEN_EXPIRES_DAYS, request.body.refreshToken);
  const accessToken = app.signAccessToken(user);
  return { accessToken, refreshToken, user };
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/auth/refresh.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.schemas.ts src/modules/auth/auth.routes.ts test/integration/modules/auth/refresh.test.ts
git commit -m "feat: POST /auth/refresh with rotation and replay protection"
```

---

## Task 14: Logout endpoint

**Files:**
- Modify: `src/modules/auth/auth.service.ts` (add `logout`)
- Modify: `src/modules/auth/auth.routes.ts` (add `POST /auth/logout`)
- Test: `test/integration/modules/auth/logout.test.ts`

**Interfaces:**
- Produces: `logout(dataSource, presentedToken): Promise<void>` — revokes the matching refresh token if one exists; no-ops silently for an unknown token (logout is idempotent, never leaks whether a token existed).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/auth/logout.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedAdmin } from '../../../../src/db/seed-admin';

describe('POST /auth/logout', () => {
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
    await ds.query('DELETE FROM refresh_tokens');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('revokes the refresh token so it can no longer be used to refresh', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    const logoutRes = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });
    expect(logoutRes.statusCode).toBe(204);

    const refreshRes = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refreshRes.statusCode).toBe(401);

    await app.close();
  });

  it('returns 204 even for an unknown token (idempotent, no information leak)', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: 'unknown-token' } });
    expect(res.statusCode).toBe(204);

    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/auth/logout.test.ts`
Expected: FAIL — `/auth/logout` route doesn't exist (404).

- [ ] **Step 3: Add logout to src/modules/auth/auth.service.ts**

```typescript
export async function logout(dataSource: DataSource, presentedToken: string): Promise<void> {
  await dataSource.getRepository(RefreshToken).update({ tokenHash: hashToken(presentedToken) }, { revokedAt: new Date() });
}
```

- [ ] **Step 4: Add the route in src/modules/auth/auth.routes.ts**

```typescript
// add to imports
import { logout } from './auth.service';

// add inside authRoutes, after the /auth/refresh route
typedApp.post('/auth/logout', {
  schema: { body: refreshBodySchema },
}, async (request, reply) => {
  await logout(app.dataSource, request.body.refreshToken);
  reply.status(204).send();
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/auth/logout.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.routes.ts test/integration/modules/auth/logout.test.ts
git commit -m "feat: POST /auth/logout with refresh token revocation"
```

---

## Task 15: Audit log schema & write function

**Files:**
- Create: `src/modules/audit/entities/audit-log.entity.ts`
- Create: `src/db/migrations/1700000002000-create-audit-log.ts`
- Create: `src/modules/audit/audit.service.ts`
- Test: `test/integration/modules/audit/audit-service.test.ts`

**Interfaces:**
- Produces: `AuditLog { id, caseId (nullable), actorId, action, beforeValue (jsonb, nullable), afterValue (jsonb, nullable), createdAt }`, `logAuditEvent(dataSource, entry: { actorId, action, caseId?, beforeValue?, afterValue? }): Promise<void>` — this is what every later mutating service (users, master-data, and in Phase 2+ cases) calls explicitly at the point of change. `caseId` has no FK constraint yet since the `cases` table doesn't exist until Phase 2 — it is added as a plain nullable `uuid` column now.

- [ ] **Step 1: Write the entity**

```typescript
// src/modules/audit/entities/audit-log.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  caseId!: string | null;

  @Column({ type: 'uuid' })
  actorId!: string;

  @Column()
  action!: string;

  @Column({ type: 'jsonb', nullable: true })
  beforeValue!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  afterValue!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;
}
```

- [ ] **Step 2: Write the migration**

```typescript
// src/db/migrations/1700000002000-create-audit-log.ts
import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreateAuditLog1700000002000 implements MigrationInterface {
  name = 'CreateAuditLog1700000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'audit_log',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid', isNullable: true },
          { name: 'actorId', type: 'uuid' },
          { name: 'action', type: 'varchar' },
          { name: 'beforeValue', type: 'jsonb', isNullable: true },
          { name: 'afterValue', type: 'jsonb', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('audit_log');
  }
}
```

- [ ] **Step 3: Write the failing test**

```typescript
// test/integration/modules/audit/audit-service.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { AuditLog } from '../../../../src/modules/audit/entities/audit-log.entity';

describe('logAuditEvent', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
  });

  it('writes an entry with before/after values', async () => {
    await logAuditEvent(ds, {
      actorId: '11111111-1111-1111-1111-111111111111',
      action: 'user.deactivated',
      beforeValue: { isActive: true },
      afterValue: { isActive: false },
    });

    const rows = await ds.getRepository(AuditLog).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.deactivated');
    expect(rows[0].beforeValue).toEqual({ isActive: true });
    expect(rows[0].afterValue).toEqual({ isActive: false });
    expect(rows[0].caseId).toBeNull();
  });

  it('defaults beforeValue/afterValue to null when omitted', async () => {
    await logAuditEvent(ds, { actorId: '11111111-1111-1111-1111-111111111111', action: 'user.created' });
    const [row] = await ds.getRepository(AuditLog).find();
    expect(row.beforeValue).toBeNull();
    expect(row.afterValue).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/audit/audit-service.test.ts`
Expected: FAIL — `audit.service` module not found.

- [ ] **Step 5: Write src/modules/audit/audit.service.ts**

```typescript
import type { DataSource } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export async function logAuditEvent(
  dataSource: DataSource,
  entry: {
    actorId: string;
    action: string;
    caseId?: string | null;
    beforeValue?: unknown;
    afterValue?: unknown;
  },
): Promise<void> {
  const repo = dataSource.getRepository(AuditLog);
  await repo.save(
    repo.create({
      actorId: entry.actorId,
      action: entry.action,
      caseId: entry.caseId ?? null,
      beforeValue: (entry.beforeValue ?? null) as Record<string, unknown> | null,
      afterValue: (entry.afterValue ?? null) as Record<string, unknown> | null,
    }),
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/audit/audit-service.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/modules/audit/entities/audit-log.entity.ts src/db/migrations/1700000002000-create-audit-log.ts src/modules/audit/audit.service.ts test/integration/modules/audit/audit-service.test.ts
git commit -m "feat: audit_log schema and logAuditEvent write function"
```

---

## Task 16: Pagination helper & audit list endpoint

**Files:**
- Create: `src/shared/pagination.ts`
- Test: `test/unit/shared/pagination.test.ts`
- Create: `src/modules/audit/audit.schemas.ts`
- Create: `src/modules/audit/audit.routes.ts`
- Modify: `src/app.ts` (register `auditRoutes`)
- Test: `test/integration/modules/audit/audit-routes.test.ts`

**Interfaces:**
- Produces: `paginationQuerySchema` (Zod, `page`/`pageSize`), `paginationToSkipTake(query)`, `buildPaginatedResponse(items, total, query)` — reused by every later list endpoint (users, master-data, and in later phases, cases/reports).
- Produces: `GET /audit` (admin/legal_manager only), filterable by `actorId`/`action`/`caseId`, paginated.

- [ ] **Step 1: Write the failing pagination test**

```typescript
// test/unit/shared/pagination.test.ts
import { describe, it, expect } from 'vitest';
import { paginationQuerySchema, paginationToSkipTake, buildPaginatedResponse } from '../../../src/shared/pagination';

describe('pagination helpers', () => {
  it('defaults to page 1, pageSize 20', () => {
    const parsed = paginationQuerySchema.parse({});
    expect(parsed).toEqual({ page: 1, pageSize: 20 });
  });

  it('converts page/pageSize into skip/take', () => {
    expect(paginationToSkipTake({ page: 3, pageSize: 10 })).toEqual({ skip: 20, take: 10 });
  });

  it('builds a paginated response envelope', () => {
    const result = buildPaginatedResponse(['a', 'b'], 42, { page: 2, pageSize: 2 });
    expect(result).toEqual({ items: ['a', 'b'], total: 42, page: 2, pageSize: 2 });
  });

  it('rejects a pageSize above 100', () => {
    expect(() => paginationQuerySchema.parse({ pageSize: 500 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/shared/pagination.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/shared/pagination.ts**

```typescript
import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginationToSkipTake(query: PaginationQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

export function buildPaginatedResponse<T>(items: T[], total: number, query: PaginationQuery) {
  return { items, total, page: query.page, pageSize: query.pageSize };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/shared/pagination.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing audit-routes test**

```typescript
// test/integration/modules/audit/audit-routes.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function tokenFor(app: ReturnType<typeof buildTestApp>, role: string) {
  return app.signAccessToken({ id: ADMIN_ID, role, departmentId: null, entityId: null, businessUnitId: null });
}

describe('GET /audit', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
  });

  it('rejects an unauthenticated request', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/audit' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a requester role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = tokenFor(app, 'requester');
    const res = await app.inject({ method: 'GET', url: '/audit', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns paginated entries for an admin', async () => {
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.created' });
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.deactivated' });

    const app = buildTestApp(ds);
    await app.ready();
    const token = tokenFor(app, 'admin');
    const res = await app.inject({ method: 'GET', url: '/audit', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    await app.close();
  });

  it('filters by action', async () => {
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.created' });
    await logAuditEvent(ds, { actorId: ADMIN_ID, action: 'user.deactivated' });

    const app = buildTestApp(ds);
    await app.ready();
    const token = tokenFor(app, 'legal_manager');
    const res = await app.inject({
      method: 'GET',
      url: '/audit?action=user.created',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().items).toHaveLength(1);
    await app.close();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/audit/audit-routes.test.ts`
Expected: FAIL — `/audit` route doesn't exist (404).

- [ ] **Step 7: Write src/modules/audit/audit.schemas.ts**

```typescript
import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination';

export const auditQuerySchema = paginationQuerySchema.extend({
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
  caseId: z.string().uuid().optional(),
});

export const auditListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      caseId: z.string().nullable(),
      actorId: z.string(),
      action: z.string(),
      beforeValue: z.unknown().nullable(),
      afterValue: z.unknown().nullable(),
      createdAt: z.string(),
    }),
  ),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
```

- [ ] **Step 8: Write src/modules/audit/audit.routes.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { paginationToSkipTake, buildPaginatedResponse } from '../../shared/pagination';
import { AuditLog } from './entities/audit-log.entity';
import { auditQuerySchema, auditListResponseSchema } from './audit.schemas';

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/audit', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { querystring: auditQuerySchema, response: { 200: auditListResponseSchema } },
  }, async (request) => {
    const query = request.query;
    const repo = app.dataSource.getRepository(AuditLog);
    const { skip, take } = paginationToSkipTake(query);

    const where: Record<string, unknown> = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.caseId) where.caseId = query.caseId;

    const [items, total] = await repo.findAndCount({ where, skip, take, order: { createdAt: 'DESC' } });
    return buildPaginatedResponse(items, total, query);
  });
}
```

- [ ] **Step 9: Register the routes in src/app.ts**

```typescript
// src/app.ts — add import
import auditRoutes from './modules/audit/audit.routes';

// inside buildApp(dataSource), after app.register(authRoutes):
app.register(auditRoutes);
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/audit/audit-routes.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 11: Commit**

```bash
git add src/shared/pagination.ts test/unit/shared/pagination.test.ts src/modules/audit/audit.schemas.ts src/modules/audit/audit.routes.ts src/app.ts test/integration/modules/audit/audit-routes.test.ts
git commit -m "feat: pagination helper and GET /audit endpoint"
```

---

## Task 17: Create user endpoint

**Files:**
- Create: `src/modules/users/users.service.ts`
- Create: `src/modules/users/users.schemas.ts`
- Create: `src/modules/users/users.routes.ts`
- Modify: `src/app.ts` (register `usersRoutes`)
- Test: `test/integration/modules/users/create-user.test.ts`

**Interfaces:**
- Consumes: `hashPassword` (Task 9), `logAuditEvent` (Task 15), `requireRole` (Task 6), `ConflictError`/`NotFoundError`/`ValidationError` (Task 5).
- Produces: `type UserWithRole = { id, fullName, email, designation, phone, departmentId, entityId, businessUnitId, isActive, role, createdAt, updatedAt }`, `assignRole(dataSource, userId, roleId, assignedBy): Promise<void>` (atomic upsert on `user_roles.userId` — reused by Task 19), `createUser(dataSource, actorId, input): Promise<UserWithRole>` (always assigns `requester`, PR-31).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/users/create-user.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('POST /users', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('creates a user defaulted to the requester role (PR-31)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'Jane@Algihaz.local', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe('requester');
    expect(body.email).toBe('jane@algihaz.local');

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.created'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('rejects a duplicate email that only differs by case', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'jane@algihaz.local', password: 'Password123!' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Duplicate', email: 'Jane@Algihaz.local', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects creation by a non-admin role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: ADMIN_ID, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Someone', email: 'someone@algihaz.local', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a password shorter than 8 characters', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Someone', email: 'someone@algihaz.local', password: 'short' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/users/create-user.test.ts`
Expected: FAIL — `/users` route doesn't exist (404).

- [ ] **Step 3: Write src/modules/users/users.service.ts**

```typescript
import type { DataSource } from 'typeorm';
import { User } from './entities/user.entity';
import { Role, RoleName } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { hashPassword } from '../../shared/password';
import { logAuditEvent } from '../audit/audit.service';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { PaginationQuery, paginationToSkipTake } from '../../shared/pagination';

export type UserWithRole = {
  id: string;
  fullName: string;
  email: string;
  designation: string | null;
  phone: string | null;
  departmentId: string | null;
  entityId: string | null;
  businessUnitId: string | null;
  isActive: boolean;
  role: string;
  createdAt: string;
  updatedAt: string;
};

function toUserWithRole(user: User, role: string): UserWithRole {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    designation: user.designation,
    phone: user.phone,
    departmentId: user.departmentId,
    entityId: user.entityId,
    businessUnitId: user.businessUnitId,
    isActive: user.isActive,
    role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function assignRole(
  dataSource: DataSource,
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<void> {
  await dataSource
    .getRepository(UserRole)
    .upsert({ userId, roleId, assignedBy }, { conflictPaths: ['userId'] });
}

export type CreateUserInput = {
  fullName: string;
  email: string;
  password: string;
  designation?: string;
  phone?: string;
  departmentId?: string;
  entityId?: string;
  businessUnitId?: string;
};

export async function createUser(
  dataSource: DataSource,
  actorId: string,
  input: CreateUserInput,
): Promise<UserWithRole> {
  const email = input.email.toLowerCase();
  const userRepo = dataSource.getRepository(User);

  const existing = await userRepo.findOne({ where: { email } });
  if (existing) {
    throw new ConflictError('A user with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await userRepo.save(
    userRepo.create({
      fullName: input.fullName,
      email,
      passwordHash,
      designation: input.designation ?? null,
      phone: input.phone ?? null,
      departmentId: input.departmentId ?? null,
      entityId: input.entityId ?? null,
      businessUnitId: input.businessUnitId ?? null,
      isActive: true,
    }),
  );

  const requesterRole = await dataSource.getRepository(Role).findOneOrFail({ where: { name: 'requester' as RoleName } });
  await assignRole(dataSource, user.id, requesterRole.id, actorId);

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.created',
    afterValue: { id: user.id, email: user.email, role: 'requester' },
  });

  return toUserWithRole(user, 'requester');
}
```

- [ ] **Step 4: Write src/modules/users/users.schemas.ts**

```typescript
import { z } from 'zod';
import { ROLE_NAMES } from './entities/role.entity';

export const createUserBodySchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  designation: z.string().optional(),
  phone: z.string().optional(),
  departmentId: z.string().uuid().optional(),
  entityId: z.string().uuid().optional(),
  businessUnitId: z.string().uuid().optional(),
});

export const userResponseSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string(),
  designation: z.string().nullable(),
  phone: z.string().nullable(),
  departmentId: z.string().nullable(),
  entityId: z.string().nullable(),
  businessUnitId: z.string().nullable(),
  isActive: z.boolean(),
  role: z.enum(ROLE_NAMES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

- [ ] **Step 5: Write src/modules/users/users.routes.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import { createUser } from './users.service';
import { createUserBodySchema, userResponseSchema } from './users.schemas';

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post('/users', {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createUserBodySchema, response: { 201: userResponseSchema } },
  }, async (request, reply) => {
    const user = await createUser(app.dataSource, request.user.id, request.body);
    reply.status(201).send(user);
  });
}
```

- [ ] **Step 6: Register the routes in src/app.ts**

```typescript
// src/app.ts — add import
import usersRoutes from './modules/users/users.routes';

// inside buildApp(dataSource), after app.register(auditRoutes):
app.register(usersRoutes);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/users/create-user.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add src/modules/users/users.service.ts src/modules/users/users.schemas.ts src/modules/users/users.routes.ts src/app.ts test/integration/modules/users/create-user.test.ts
git commit -m "feat: POST /users — admin creates accounts, default requester role"
```

---

## Task 18: List & get user endpoints

**Files:**
- Modify: `src/modules/users/users.service.ts` (add `listUsers`, `getUserById`)
- Modify: `src/modules/users/users.schemas.ts` (add `userListQuerySchema`, `userListResponseSchema`, `userIdParamsSchema`)
- Modify: `src/modules/users/users.routes.ts` (add `GET /users`, `GET /users/:id`)
- Test: `test/integration/modules/users/list-users.test.ts`

**Interfaces:**
- Consumes: `paginationQuerySchema`/`paginationToSkipTake`/`buildPaginatedResponse` (Task 16), `UserWithRole` (Task 17).
- Produces: `listUsers(dataSource, query: PaginationQuery): Promise<{ items: UserWithRole[]; total: number }>`, `getUserById(dataSource, id): Promise<UserWithRole>` (throws `NotFoundError`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/users/list-users.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('GET /users, GET /users/:id', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('lists users with their role and a paginated envelope', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane Requester', email: 'jane@algihaz.local', password: 'Password123!' },
    });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].role).toBe('requester');

    await app.close();
  });

  it('allows legal_manager to list users (visibility without edit, PR-22)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const managerToken = app.signAccessToken({ id: ADMIN_ID, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${managerToken}` } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('returns 404 for an unknown user id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'GET',
      url: '/users/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects list access for a requester role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: ADMIN_ID, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/users', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);

    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/users/list-users.test.ts`
Expected: FAIL — `GET /users` route doesn't exist (404 for the wrong reason — no route registered).

- [ ] **Step 3: Add listUsers/getUserById to src/modules/users/users.service.ts**

```typescript
// add to imports
import { PaginationQuery, paginationToSkipTake } from '../../shared/pagination';

export async function listUsers(
  dataSource: DataSource,
  query: PaginationQuery,
): Promise<{ items: UserWithRole[]; total: number }> {
  const { skip, take } = paginationToSkipTake(query);
  const repo = dataSource.getRepository(User);
  const total = await repo.count();

  const { entities, raw } = await repo
    .createQueryBuilder('user')
    .leftJoin(UserRole, 'ur', 'ur."userId" = user.id')
    .leftJoin(Role, 'role', 'role.id = ur."roleId"')
    .addSelect('role.name', 'role_name')
    .orderBy('user.createdAt', 'DESC')
    .skip(skip)
    .take(take)
    .getRawAndEntities();

  const items = entities.map((user, idx) => toUserWithRole(user, raw[idx].role_name as string));
  return { items, total };
}

export async function getUserById(dataSource: DataSource, id: string): Promise<UserWithRole> {
  const user = await dataSource.getRepository(User).findOne({ where: { id } });
  if (!user) {
    throw new NotFoundError('User not found');
  }
  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId: id } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });
  return toUserWithRole(user, role.name);
}
```

- [ ] **Step 4: Add schemas to src/modules/users/users.schemas.ts**

```typescript
import { paginationQuerySchema } from '../../shared/pagination';

export const userListQuerySchema = paginationQuerySchema;

export const userListResponseSchema = z.object({
  items: z.array(userResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export const userIdParamsSchema = z.object({
  id: z.string().uuid(),
});
```

- [ ] **Step 5: Add routes to src/modules/users/users.routes.ts**

```typescript
// add to imports
import { listUsers, getUserById } from './users.service';
import { buildPaginatedResponse } from '../../shared/pagination';
import { userListQuerySchema, userListResponseSchema, userIdParamsSchema } from './users.schemas';

// add inside usersRoutes, after the POST /users route
typedApp.get('/users', {
  preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
  schema: { querystring: userListQuerySchema, response: { 200: userListResponseSchema } },
}, async (request) => {
  const { items, total } = await listUsers(app.dataSource, request.query);
  return buildPaginatedResponse(items, total, request.query);
});

typedApp.get('/users/:id', {
  preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
  schema: { params: userIdParamsSchema, response: { 200: userResponseSchema } },
}, async (request) => {
  return getUserById(app.dataSource, request.params.id);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/users/list-users.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/modules/users/users.service.ts src/modules/users/users.schemas.ts src/modules/users/users.routes.ts test/integration/modules/users/list-users.test.ts
git commit -m "feat: GET /users and GET /users/:id"
```

---

## Task 19: Update user role endpoint

**Files:**
- Modify: `src/modules/users/users.service.ts` (add `updateUserRole`)
- Modify: `src/modules/users/users.schemas.ts` (add `updateUserRoleBodySchema`)
- Modify: `src/modules/users/users.routes.ts` (add `PATCH /users/:id/role`)
- Test: `test/integration/modules/users/update-role.test.ts`

**Interfaces:**
- Consumes: `assignRole` (Task 17), `ROLE_NAMES`/`RoleName` (Task 8).
- Produces: `updateUserRole(dataSource, actorId, userId, roleName): Promise<UserWithRole>` — admin-only, audit logged, uses the atomic `assignRole` upsert so a role change is race-safe by construction.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/users/update-role.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('PATCH /users/:id/role', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it("changes a user's role and logs the change", async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'legal_rep' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('legal_rep');

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.role_changed'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('holds up under two concurrent role-change requests without error or duplicate rows', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane2@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/users/${userId}/role`, headers: { authorization: `Bearer ${token}` }, payload: { role: 'legal_rep' } }),
      app.inject({ method: 'PATCH', url: `/users/${userId}/role`, headers: { authorization: `Bearer ${token}` }, payload: { role: 'viewer' } }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await ds.query(`SELECT "roleId" FROM user_roles WHERE "userId" = $1`, [userId]);
    expect(rows).toHaveLength(1);

    await app.close();
  });

  it('rejects an unknown role name with a validation error', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane3@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'super_admin' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects role changes from a non-admin role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const managerToken = app.signAccessToken({ id: ADMIN_ID, role: 'legal_manager', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/00000000-0000-0000-0000-000000000000/role`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/users/update-role.test.ts`
Expected: FAIL — `PATCH /users/:id/role` route doesn't exist (404).

- [ ] **Step 3: Add updateUserRole to src/modules/users/users.service.ts**

```typescript
export async function updateUserRole(
  dataSource: DataSource,
  actorId: string,
  userId: string,
  roleName: RoleName,
): Promise<UserWithRole> {
  const user = await dataSource.getRepository(User).findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const role = await dataSource.getRepository(Role).findOne({ where: { name: roleName } });
  if (!role) {
    throw new ValidationError(`Unknown role: ${roleName}`);
  }

  const previous = await dataSource.getRepository(UserRole).findOne({ where: { userId } });
  await assignRole(dataSource, userId, role.id, actorId);

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.role_changed',
    beforeValue: { roleId: previous?.roleId ?? null },
    afterValue: { roleId: role.id, roleName: role.name },
  });

  return toUserWithRole(user, role.name);
}
```

- [ ] **Step 4: Add schema to src/modules/users/users.schemas.ts**

```typescript
export const updateUserRoleBodySchema = z.object({
  role: z.enum(ROLE_NAMES),
});
```

- [ ] **Step 5: Add route to src/modules/users/users.routes.ts**

```typescript
// add to imports
import { updateUserRole } from './users.service';
import { updateUserRoleBodySchema } from './users.schemas';

// add inside usersRoutes, after GET /users/:id
typedApp.patch('/users/:id/role', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { params: userIdParamsSchema, body: updateUserRoleBodySchema, response: { 200: userResponseSchema } },
}, async (request) => {
  return updateUserRole(app.dataSource, request.user.id, request.params.id, request.body.role);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/users/update-role.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/modules/users/users.service.ts src/modules/users/users.schemas.ts src/modules/users/users.routes.ts test/integration/modules/users/update-role.test.ts
git commit -m "feat: PATCH /users/:id/role with atomic, race-safe role assignment"
```

---

## Task 20: Deactivate user endpoint

**Files:**
- Modify: `src/modules/users/users.service.ts` (add `deactivateUser`)
- Modify: `src/modules/users/users.routes.ts` (add `PATCH /users/:id/deactivate`)
- Test: `test/integration/modules/users/deactivate-user.test.ts`

**Interfaces:**
- Produces: `deactivateUser(dataSource, actorId, userId): Promise<UserWithRole>` — throws `ForbiddenError` if `actorId === userId` (VC-18/PR-25: can't deactivate/delete your own account), audit logged.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/users/deactivate-user.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>, id = ADMIN_ID) {
  return app.signAccessToken({ id, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('PATCH /users/:id/deactivate', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('deactivates another user and logs the change', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Jane', email: 'jane@algihaz.local', password: 'Password123!' },
    });
    const userId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${userId}/deactivate`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'user.deactivated'`);
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('rejects an admin attempting to deactivate their own account (VC-18/PR-25)', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    await ds.query(
      `INSERT INTO users (id, "fullName", email, "passwordHash") VALUES ($1, 'Self Admin', 'self@algihaz.local', 'x')`,
      [ADMIN_ID],
    );
    const token = adminToken(app);

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${ADMIN_ID}/deactivate`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 404 for an unknown user id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'PATCH',
      url: '/users/00000000-0000-0000-0000-000000000000/deactivate',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/users/deactivate-user.test.ts`
Expected: FAIL — `PATCH /users/:id/deactivate` route doesn't exist (404).

- [ ] **Step 3: Add deactivateUser to src/modules/users/users.service.ts**

```typescript
// add to imports
import { ForbiddenError } from '../../shared/errors';

export async function deactivateUser(dataSource: DataSource, actorId: string, userId: string): Promise<UserWithRole> {
  if (actorId === userId) {
    throw new ForbiddenError('You cannot deactivate your own account');
  }

  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError('User not found');
  }

  user.isActive = false;
  await userRepo.save(user);

  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.deactivated',
    beforeValue: { isActive: true },
    afterValue: { isActive: false },
  });

  return toUserWithRole(user, role.name);
}
```

- [ ] **Step 4: Add route to src/modules/users/users.routes.ts**

```typescript
// add to imports
import { deactivateUser } from './users.service';

// add inside usersRoutes, after PATCH /users/:id/role
typedApp.patch('/users/:id/deactivate', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { params: userIdParamsSchema, response: { 200: userResponseSchema } },
}, async (request) => {
  return deactivateUser(app.dataSource, request.user.id, request.params.id);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/users/deactivate-user.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/modules/users/users.service.ts src/modules/users/users.routes.ts test/integration/modules/users/deactivate-user.test.ts
git commit -m "feat: PATCH /users/:id/deactivate with self-deactivation guard"
```

---

## Task 21: Generic simple master-data resource + departments

**Files:**
- Create: `src/modules/master-data/simple-resource.ts`
- Create: `src/modules/master-data/entities/department.entity.ts`
- Create: `src/modules/master-data/entities/case-category.entity.ts`
- Create: `src/modules/master-data/entities/closure-outcome.entity.ts`
- Create: `src/db/migrations/1700000003000-create-simple-master-data.ts`
- Create: `src/modules/master-data/master-data.routes.ts`
- Modify: `src/app.ts` (register `masterDataRoutes`)
- Test: `test/integration/modules/master-data/departments.test.ts`

**Interfaces:**
- Consumes: `requireRole` (Task 6), `logAuditEvent` (Task 15), `ConflictError`/`NotFoundError` (Task 5).
- Produces: `registerSimpleMasterDataResource(app, { path, entity, auditPrefix }): void` — mounts `GET/POST <path>` and `PATCH <path>/:id` for any entity shaped `{ id, name, isActive }`; there is **no DELETE route** anywhere in this module — deactivation is always `PATCH { isActive: false }`, never a hard delete (Review Focus: FK/history safety). Reused as-is by Task 22 for `case_categories` and `closure_outcomes` — the migration in this task creates all three tables up front since they're structurally identical, even though only `departments` gets routes here.

- [ ] **Step 1: Write the entities**

```typescript
// src/modules/master-data/entities/department.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('departments')
export class Department {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ default: true })
  isActive!: boolean;
}
```

```typescript
// src/modules/master-data/entities/case-category.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('case_categories')
export class CaseCategory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ default: true })
  isActive!: boolean;
}
```

```typescript
// src/modules/master-data/entities/closure-outcome.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('closure_outcomes')
export class ClosureOutcome {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ default: true })
  isActive!: boolean;
}
```

- [ ] **Step 2: Write the migration**

```typescript
// src/db/migrations/1700000003000-create-simple-master-data.ts
import { MigrationInterface, QueryRunner, Table } from 'typeorm';

const SIMPLE_TABLES = ['departments', 'case_categories', 'closure_outcomes'];

export class CreateSimpleMasterData1700000003000 implements MigrationInterface {
  name = 'CreateSimpleMasterData1700000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const tableName of SIMPLE_TABLES) {
      await queryRunner.createTable(
        new Table({
          name: tableName,
          columns: [
            { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
            { name: 'name', type: 'varchar', isUnique: true },
            { name: 'isActive', type: 'boolean', default: true },
          ],
        }),
      );
    }

    await queryRunner.query(
      `INSERT INTO case_categories (name) VALUES ('Najiz'), ('Baladi Violation'), ('HR Termination'), ('Internal')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tableName of [...SIMPLE_TABLES].reverse()) {
      await queryRunner.dropTable(tableName);
    }
  }
}
```

- [ ] **Step 3: Write the failing test**

```typescript
// test/integration/modules/master-data/departments.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('/departments', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM audit_log');
    await ds.query('DELETE FROM departments');
  });

  it('creates and lists a department', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const create = await app.inject({
      method: 'POST',
      url: '/departments',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Human Resources' },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/departments', headers: { authorization: `Bearer ${token}` } });
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('rejects a duplicate department name', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Finance' } });
    const dup = await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Finance' } });

    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it('soft-deactivates via PATCH isActive:false instead of deleting (DM-09 immediate effect, no hard delete)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const create = await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Legal' } });
    const id = create.json().id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/departments/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isActive: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().isActive).toBe(false);

    const row = await ds.query(`SELECT id FROM departments WHERE id = $1`, [id]);
    expect(row).toHaveLength(1);

    await app.close();
  });

  it('rejects create/update from a non-admin role but still allows reads (UI-18)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const requesterToken = app.signAccessToken({ id: ADMIN_ID, role: 'requester', departmentId: null, entityId: null, businessUnitId: null });

    const createAttempt = await app.inject({ method: 'POST', url: '/departments', headers: { authorization: `Bearer ${requesterToken}` }, payload: { name: 'X' } });
    expect(createAttempt.statusCode).toBe(403);

    const readAttempt = await app.inject({ method: 'GET', url: '/departments', headers: { authorization: `Bearer ${requesterToken}` } });
    expect(readAttempt.statusCode).toBe(200);

    await app.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/master-data/departments.test.ts`
Expected: FAIL — `/departments` route doesn't exist (404).

- [ ] **Step 5: Write src/modules/master-data/simple-resource.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { EntityTarget, ObjectLiteral } from 'typeorm';
import { z } from 'zod';
import { requireRole } from '../../shared/rbac';
import { logAuditEvent } from '../audit/audit.service';
import { ConflictError, NotFoundError } from '../../shared/errors';

type SimpleResourceRow = { id: string; name: string; isActive: boolean };

export function registerSimpleMasterDataResource<T extends SimpleResourceRow & ObjectLiteral>(
  app: FastifyInstance,
  options: { path: string; entity: EntityTarget<T>; auditPrefix: string },
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const itemSchema = z.object({ id: z.string(), name: z.string(), isActive: z.boolean() });
  const createBodySchema = z.object({ name: z.string().min(1) });
  const updateBodySchema = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional() });
  const idParamsSchema = z.object({ id: z.string().uuid() });

  typedApp.get(options.path, {
    preHandler: [app.authenticate],
    schema: { response: { 200: z.array(itemSchema) } },
  }, async () => {
    return app.dataSource.getRepository(options.entity).find({ order: { name: 'ASC' } as never });
  });

  typedApp.post(options.path, {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { body: createBodySchema, response: { 201: itemSchema } },
  }, async (request, reply) => {
    const repo = app.dataSource.getRepository(options.entity);
    const existing = await repo.findOne({ where: { name: request.body.name } as never });
    if (existing) {
      throw new ConflictError(`'${request.body.name}' already exists`);
    }
    const row = await repo.save(repo.create({ name: request.body.name, isActive: true } as never));
    await logAuditEvent(app.dataSource, { actorId: request.user.id, action: `${options.auditPrefix}.created`, afterValue: row });
    reply.status(201).send(row);
  });

  typedApp.patch(`${options.path}/:id`, {
    preHandler: [app.authenticate, requireRole(['admin'])],
    schema: { params: idParamsSchema, body: updateBodySchema, response: { 200: itemSchema } },
  }, async (request) => {
    const repo = app.dataSource.getRepository(options.entity);
    const row = await repo.findOne({ where: { id: request.params.id } as never });
    if (!row) {
      throw new NotFoundError('Not found');
    }
    const before = { name: row.name, isActive: row.isActive };
    if (request.body.name !== undefined) row.name = request.body.name;
    if (request.body.isActive !== undefined) row.isActive = request.body.isActive;
    await repo.save(row);
    await logAuditEvent(app.dataSource, {
      actorId: request.user.id,
      action: `${options.auditPrefix}.updated`,
      beforeValue: before,
      afterValue: { name: row.name, isActive: row.isActive },
    });
    return row;
  });
}
```

- [ ] **Step 6: Write src/modules/master-data/master-data.routes.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import { registerSimpleMasterDataResource } from './simple-resource';
import { Department } from './entities/department.entity';

export default async function masterDataRoutes(app: FastifyInstance): Promise<void> {
  registerSimpleMasterDataResource(app, { path: '/departments', entity: Department, auditPrefix: 'department' });
}
```

- [ ] **Step 7: Register the routes in src/app.ts**

```typescript
// src/app.ts — add import
import masterDataRoutes from './modules/master-data/master-data.routes';

// inside buildApp(dataSource), after app.register(usersRoutes):
app.register(masterDataRoutes);
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/master-data/departments.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add src/modules/master-data src/db/migrations/1700000003000-create-simple-master-data.ts src/app.ts test/integration/modules/master-data/departments.test.ts
git commit -m "feat: generic simple master-data resource + /departments"
```

---

## Task 22: Case categories & closure outcomes

**Files:**
- Modify: `src/modules/master-data/master-data.routes.ts` (mount `/case-categories`, `/closure-outcomes`)
- Test: `test/integration/modules/master-data/case-categories.test.ts`

**Interfaces:**
- Consumes: `registerSimpleMasterDataResource` (Task 21) — tables already exist from Task 21's migration, including the four categories seeded there (DM-01: Najiz, Baladi Violation, HR Termination, Internal).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/master-data/case-categories.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

describe('/case-categories, /closure-outcomes', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('lists the four seeded case categories (DM-01)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: ADMIN_ID, role: 'viewer', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({ method: 'GET', url: '/case-categories', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const names = res.json().map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['Baladi Violation', 'HR Termination', 'Internal', 'Najiz']);

    await app.close();
  });

  it('admin can add a new closure outcome (PR-29, extensible master data)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/closure-outcomes',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Settled Out of Court' },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/master-data/case-categories.test.ts`
Expected: FAIL — `/case-categories` and `/closure-outcomes` routes don't exist (404).

- [ ] **Step 3: Update src/modules/master-data/master-data.routes.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import { registerSimpleMasterDataResource } from './simple-resource';
import { Department } from './entities/department.entity';
import { CaseCategory } from './entities/case-category.entity';
import { ClosureOutcome } from './entities/closure-outcome.entity';

export default async function masterDataRoutes(app: FastifyInstance): Promise<void> {
  registerSimpleMasterDataResource(app, { path: '/departments', entity: Department, auditPrefix: 'department' });
  registerSimpleMasterDataResource(app, { path: '/case-categories', entity: CaseCategory, auditPrefix: 'case_category' });
  registerSimpleMasterDataResource(app, { path: '/closure-outcomes', entity: ClosureOutcome, auditPrefix: 'closure_outcome' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/master-data/case-categories.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/master-data/master-data.routes.ts test/integration/modules/master-data/case-categories.test.ts
git commit -m "feat: /case-categories and /closure-outcomes master data endpoints"
```

---

## Task 23: Entities & business units

**Files:**
- Create: `src/modules/master-data/entities/org-entity.entity.ts`
- Create: `src/modules/master-data/entities/business-unit.entity.ts`
- Create: `src/db/migrations/1700000004000-create-entities-and-business-units.ts`
- Create: `src/modules/master-data/org-structure.service.ts`
- Create: `src/modules/master-data/org-structure.schemas.ts`
- Modify: `src/modules/master-data/master-data.routes.ts`
- Test: `test/integration/modules/master-data/org-structure.test.ts`

**Interfaces:**
- Produces: `listEntities`, `createEntity`, `updateEntity`, `listBusinessUnits(dataSource, entityId?)`, `createBusinessUnit`, `updateBusinessUnit` — all `(dataSource, actorId, ...)`, audit-logged, admin-only for writes. Seeds the 10 entities from DM-03 (AGC, CCE, Craft, NewFab, SEP, SELCO, Lamprell, AIGC, AMC, Enshore Subsea).

- [ ] **Step 1: Write the entities**

```typescript
// src/modules/master-data/entities/org-entity.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('entities')
export class OrgEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ unique: true })
  code!: string;

  @Column({ default: true })
  isActive!: boolean;
}
```

```typescript
// src/modules/master-data/entities/business-unit.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('business_units')
export class BusinessUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  entityId!: string;

  @Column()
  name!: string;

  @Column({ default: true })
  isActive!: boolean;
}
```

- [ ] **Step 2: Write the migration**

```typescript
// src/db/migrations/1700000004000-create-entities-and-business-units.ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateEntitiesAndBusinessUnits1700000004000 implements MigrationInterface {
  name = 'CreateEntitiesAndBusinessUnits1700000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'entities',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'name', type: 'varchar', isUnique: true },
          { name: 'code', type: 'varchar', isUnique: true },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'business_units',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'entityId', type: 'uuid' },
          { name: 'name', type: 'varchar' },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'business_units',
      new TableForeignKey({ columnNames: ['entityId'], referencedTableName: 'entities', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );

    await queryRunner.query(`
      INSERT INTO entities (name, code) VALUES
        ('AGC', 'AGC'), ('CCE', 'CCE'), ('Craft', 'CRAFT'), ('NewFab', 'NEWFAB'), ('SEP', 'SEP'),
        ('SELCO', 'SELCO'), ('Lamprell', 'LAMPRELL'), ('AIGC', 'AIGC'), ('AMC', 'AMC'), ('Enshore Subsea', 'ENSHORE')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('business_units');
    await queryRunner.dropTable('entities');
  }
}
```

- [ ] **Step 3: Write the failing test**

```typescript
// test/integration/modules/master-data/org-structure.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('/entities, /business-units', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('seeds the 10 required entities (DM-03)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({ method: 'GET', url: '/entities', headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toHaveLength(10);

    await app.close();
  });

  it('creates a business unit under a valid entity', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const [entity] = (await app.inject({ method: 'GET', url: '/entities', headers: { authorization: `Bearer ${token}` } })).json();

    const res = await app.inject({
      method: 'POST',
      url: '/business-units',
      headers: { authorization: `Bearer ${token}` },
      payload: { entityId: entity.id, name: 'Operations' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().entityId).toBe(entity.id);

    await app.close();
  });

  it('rejects a business unit referencing an unknown entityId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/business-units',
      headers: { authorization: `Bearer ${token}` },
      payload: { entityId: '00000000-0000-0000-0000-000000000000', name: 'Ghost BU' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists business units filtered by entityId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const entities = (await app.inject({ method: 'GET', url: '/entities', headers: { authorization: `Bearer ${token}` } })).json();
    const [first, second] = entities;

    await app.inject({ method: 'POST', url: '/business-units', headers: { authorization: `Bearer ${token}` }, payload: { entityId: first.id, name: 'Unit A' } });
    await app.inject({ method: 'POST', url: '/business-units', headers: { authorization: `Bearer ${token}` }, payload: { entityId: second.id, name: 'Unit B' } });

    const res = await app.inject({ method: 'GET', url: `/business-units?entityId=${first.id}`, headers: { authorization: `Bearer ${token}` } });
    const names = res.json().map((bu: { name: string }) => bu.name);
    expect(names).toContain('Unit A');
    expect(names).not.toContain('Unit B');

    await app.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/master-data/org-structure.test.ts`
Expected: FAIL — `/entities` and `/business-units` routes don't exist (404).

- [ ] **Step 5: Write src/modules/master-data/org-structure.service.ts**

```typescript
import type { DataSource } from 'typeorm';
import { OrgEntity } from './entities/org-entity.entity';
import { BusinessUnit } from './entities/business-unit.entity';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

export async function listEntities(dataSource: DataSource): Promise<OrgEntity[]> {
  return dataSource.getRepository(OrgEntity).find({ order: { name: 'ASC' } });
}

export async function createEntity(
  dataSource: DataSource,
  actorId: string,
  input: { name: string; code: string },
): Promise<OrgEntity> {
  const repo = dataSource.getRepository(OrgEntity);
  const existing = await repo.findOne({ where: [{ name: input.name }, { code: input.code }] });
  if (existing) {
    throw new ConflictError('An entity with this name or code already exists');
  }
  const entity = await repo.save(repo.create({ name: input.name, code: input.code, isActive: true }));
  await logAuditEvent(dataSource, { actorId, action: 'entity.created', afterValue: entity });
  return entity;
}

export async function updateEntity(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: { name?: string; code?: string; isActive?: boolean },
): Promise<OrgEntity> {
  const repo = dataSource.getRepository(OrgEntity);
  const entity = await repo.findOne({ where: { id } });
  if (!entity) {
    throw new NotFoundError('Entity not found');
  }
  const before = { name: entity.name, code: entity.code, isActive: entity.isActive };
  if (input.name !== undefined) entity.name = input.name;
  if (input.code !== undefined) entity.code = input.code;
  if (input.isActive !== undefined) entity.isActive = input.isActive;
  await repo.save(entity);
  await logAuditEvent(dataSource, {
    actorId,
    action: 'entity.updated',
    beforeValue: before,
    afterValue: { name: entity.name, code: entity.code, isActive: entity.isActive },
  });
  return entity;
}

export async function listBusinessUnits(dataSource: DataSource, entityId?: string): Promise<BusinessUnit[]> {
  const where = entityId ? { entityId } : {};
  return dataSource.getRepository(BusinessUnit).find({ where, order: { name: 'ASC' } });
}

export async function createBusinessUnit(
  dataSource: DataSource,
  actorId: string,
  input: { entityId: string; name: string },
): Promise<BusinessUnit> {
  const entity = await dataSource.getRepository(OrgEntity).findOne({ where: { id: input.entityId } });
  if (!entity) {
    throw new ValidationError('Unknown entityId');
  }

  const buRepo = dataSource.getRepository(BusinessUnit);
  const existing = await buRepo.findOne({ where: { entityId: input.entityId, name: input.name } });
  if (existing) {
    throw new ConflictError(`Business unit '${input.name}' already exists for this entity`);
  }

  const bu = await buRepo.save(buRepo.create({ entityId: input.entityId, name: input.name, isActive: true }));
  await logAuditEvent(dataSource, { actorId, action: 'business_unit.created', afterValue: bu });
  return bu;
}

export async function updateBusinessUnit(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: { name?: string; isActive?: boolean },
): Promise<BusinessUnit> {
  const repo = dataSource.getRepository(BusinessUnit);
  const bu = await repo.findOne({ where: { id } });
  if (!bu) {
    throw new NotFoundError('Business unit not found');
  }
  const before = { name: bu.name, isActive: bu.isActive };
  if (input.name !== undefined) bu.name = input.name;
  if (input.isActive !== undefined) bu.isActive = input.isActive;
  await repo.save(bu);
  await logAuditEvent(dataSource, {
    actorId,
    action: 'business_unit.updated',
    beforeValue: before,
    afterValue: { name: bu.name, isActive: bu.isActive },
  });
  return bu;
}
```

- [ ] **Step 6: Write src/modules/master-data/org-structure.schemas.ts**

```typescript
import { z } from 'zod';

export const entitySchema = z.object({ id: z.string(), name: z.string(), code: z.string(), isActive: z.boolean() });
export const createEntityBodySchema = z.object({ name: z.string().min(1), code: z.string().min(1) });
export const updateEntityBodySchema = z.object({ name: z.string().min(1).optional(), code: z.string().min(1).optional(), isActive: z.boolean().optional() });

export const businessUnitSchema = z.object({ id: z.string(), entityId: z.string(), name: z.string(), isActive: z.boolean() });
export const createBusinessUnitBodySchema = z.object({ entityId: z.string().uuid(), name: z.string().min(1) });
export const updateBusinessUnitBodySchema = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional() });
export const listBusinessUnitsQuerySchema = z.object({ entityId: z.string().uuid().optional() });

export const idParamsSchema = z.object({ id: z.string().uuid() });
```

- [ ] **Step 7: Add routes to src/modules/master-data/master-data.routes.ts**

```typescript
// add to imports
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import {
  listEntities, createEntity, updateEntity, listBusinessUnits, createBusinessUnit, updateBusinessUnit,
} from './org-structure.service';
import {
  entitySchema, createEntityBodySchema, updateEntityBodySchema,
  businessUnitSchema, createBusinessUnitBodySchema, updateBusinessUnitBodySchema, listBusinessUnitsQuerySchema,
  idParamsSchema,
} from './org-structure.schemas';
import { z } from 'zod';

// add inside masterDataRoutes, after the three registerSimpleMasterDataResource calls
const typedApp = app.withTypeProvider<ZodTypeProvider>();

typedApp.get('/entities', {
  preHandler: [app.authenticate],
  schema: { response: { 200: z.array(entitySchema) } },
}, async () => listEntities(app.dataSource));

typedApp.post('/entities', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { body: createEntityBodySchema, response: { 201: entitySchema } },
}, async (request, reply) => {
  const entity = await createEntity(app.dataSource, request.user.id, request.body);
  reply.status(201).send(entity);
});

typedApp.patch('/entities/:id', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { params: idParamsSchema, body: updateEntityBodySchema, response: { 200: entitySchema } },
}, async (request) => updateEntity(app.dataSource, request.user.id, request.params.id, request.body));

typedApp.get('/business-units', {
  preHandler: [app.authenticate],
  schema: { querystring: listBusinessUnitsQuerySchema, response: { 200: z.array(businessUnitSchema) } },
}, async (request) => listBusinessUnits(app.dataSource, request.query.entityId));

typedApp.post('/business-units', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { body: createBusinessUnitBodySchema, response: { 201: businessUnitSchema } },
}, async (request, reply) => {
  const bu = await createBusinessUnit(app.dataSource, request.user.id, request.body);
  reply.status(201).send(bu);
});

typedApp.patch('/business-units/:id', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { params: idParamsSchema, body: updateBusinessUnitBodySchema, response: { 200: businessUnitSchema } },
}, async (request) => updateBusinessUnit(app.dataSource, request.user.id, request.params.id, request.body));
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/master-data/org-structure.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add src/modules/master-data src/db/migrations/1700000004000-create-entities-and-business-units.ts test/integration/modules/master-data/org-structure.test.ts
git commit -m "feat: /entities and /business-units with hierarchy validation"
```

---

## Task 24: Case types

**Files:**
- Create: `src/modules/master-data/entities/case-type.entity.ts`
- Create: `src/db/migrations/1700000005000-create-case-types.ts`
- Create: `src/modules/master-data/case-types.service.ts`
- Create: `src/modules/master-data/case-types.schemas.ts`
- Modify: `src/modules/master-data/master-data.routes.ts`
- Test: `test/integration/modules/master-data/case-types.test.ts`

**Interfaces:**
- Produces: `listCaseTypes(dataSource, categoryId?)`, `createCaseType(dataSource, actorId, input)`, `updateCaseType(dataSource, actorId, id, input)`. Each case type carries `slaAckHours`/`slaResolutionHours` (DM-02) consumed by Phase 2's SLA due-date calculation.

- [ ] **Step 1: Write the entity**

```typescript
// src/modules/master-data/entities/case-type.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('case_types')
export class CaseType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  categoryId!: string;

  @Column()
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  description!: string | null;

  @Column({ type: 'int' })
  slaAckHours!: number;

  @Column({ type: 'int' })
  slaResolutionHours!: number;

  @Column({ default: true })
  isActive!: boolean;
}
```

- [ ] **Step 2: Write the migration**

```typescript
// src/db/migrations/1700000005000-create-case-types.ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateCaseTypes1700000005000 implements MigrationInterface {
  name = 'CreateCaseTypes1700000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'case_types',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'categoryId', type: 'uuid' },
          { name: 'name', type: 'varchar' },
          { name: 'description', type: 'varchar', isNullable: true },
          { name: 'slaAckHours', type: 'int' },
          { name: 'slaResolutionHours', type: 'int' },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'case_types',
      new TableForeignKey({ columnNames: ['categoryId'], referencedTableName: 'case_categories', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('case_types');
  }
}
```

- [ ] **Step 3: Write the failing test**

```typescript
// test/integration/modules/master-data/case-types.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

describe('/case-types', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  it('creates a case type under a valid category with SLA hours', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const [category] = (await app.inject({ method: 'GET', url: '/case-categories', headers: { authorization: `Bearer ${token}` } })).json();

    const res = await app.inject({
      method: 'POST',
      url: '/case-types',
      headers: { authorization: `Bearer ${token}` },
      payload: { categoryId: category.id, name: 'Contract Dispute', slaAckHours: 24, slaResolutionHours: 240 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().slaResolutionHours).toBe(240);

    await app.close();
  });

  it('rejects a case type with an unknown categoryId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const res = await app.inject({
      method: 'POST',
      url: '/case-types',
      headers: { authorization: `Bearer ${token}` },
      payload: { categoryId: '00000000-0000-0000-0000-000000000000', name: 'X', slaAckHours: 1, slaResolutionHours: 1 },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists case types filtered by categoryId', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const categories = (await app.inject({ method: 'GET', url: '/case-categories', headers: { authorization: `Bearer ${token}` } })).json();
    const najiz = categories.find((c: { name: string }) => c.name === 'Najiz');
    const internal = categories.find((c: { name: string }) => c.name === 'Internal');

    await app.inject({ method: 'POST', url: '/case-types', headers: { authorization: `Bearer ${token}` }, payload: { categoryId: najiz.id, name: 'Najiz Type A', slaAckHours: 24, slaResolutionHours: 100 } });
    await app.inject({ method: 'POST', url: '/case-types', headers: { authorization: `Bearer ${token}` }, payload: { categoryId: internal.id, name: 'Internal Type A', slaAckHours: 24, slaResolutionHours: 100 } });

    const res = await app.inject({ method: 'GET', url: `/case-types?categoryId=${najiz.id}`, headers: { authorization: `Bearer ${token}` } });
    const names = res.json().map((t: { name: string }) => t.name);
    expect(names).toEqual(['Najiz Type A']);

    await app.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/master-data/case-types.test.ts`
Expected: FAIL — `/case-types` route doesn't exist (404).

- [ ] **Step 5: Write src/modules/master-data/case-types.service.ts**

```typescript
import type { DataSource } from 'typeorm';
import { CaseType } from './entities/case-type.entity';
import { CaseCategory } from './entities/case-category.entity';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

export async function listCaseTypes(dataSource: DataSource, categoryId?: string): Promise<CaseType[]> {
  const where = categoryId ? { categoryId } : {};
  return dataSource.getRepository(CaseType).find({ where, order: { name: 'ASC' } });
}

export type CreateCaseTypeInput = {
  categoryId: string;
  name: string;
  description?: string;
  slaAckHours: number;
  slaResolutionHours: number;
};

export async function createCaseType(
  dataSource: DataSource,
  actorId: string,
  input: CreateCaseTypeInput,
): Promise<CaseType> {
  const category = await dataSource.getRepository(CaseCategory).findOne({ where: { id: input.categoryId } });
  if (!category) {
    throw new ValidationError('Unknown categoryId');
  }

  const repo = dataSource.getRepository(CaseType);
  const existing = await repo.findOne({ where: { categoryId: input.categoryId, name: input.name } });
  if (existing) {
    throw new ConflictError(`Case type '${input.name}' already exists for this category`);
  }

  const caseType = await repo.save(
    repo.create({
      categoryId: input.categoryId,
      name: input.name,
      description: input.description ?? null,
      slaAckHours: input.slaAckHours,
      slaResolutionHours: input.slaResolutionHours,
      isActive: true,
    }),
  );
  await logAuditEvent(dataSource, { actorId, action: 'case_type.created', afterValue: caseType });
  return caseType;
}

export async function updateCaseType(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: Partial<Omit<CreateCaseTypeInput, 'categoryId'>> & { isActive?: boolean },
): Promise<CaseType> {
  const repo = dataSource.getRepository(CaseType);
  const caseType = await repo.findOne({ where: { id } });
  if (!caseType) {
    throw new NotFoundError('Case type not found');
  }
  const before = { ...caseType };
  if (input.name !== undefined) caseType.name = input.name;
  if (input.description !== undefined) caseType.description = input.description;
  if (input.slaAckHours !== undefined) caseType.slaAckHours = input.slaAckHours;
  if (input.slaResolutionHours !== undefined) caseType.slaResolutionHours = input.slaResolutionHours;
  if (input.isActive !== undefined) caseType.isActive = input.isActive;
  await repo.save(caseType);
  await logAuditEvent(dataSource, { actorId, action: 'case_type.updated', beforeValue: before, afterValue: caseType });
  return caseType;
}
```

- [ ] **Step 6: Write src/modules/master-data/case-types.schemas.ts**

```typescript
import { z } from 'zod';

export const caseTypeSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  slaAckHours: z.number(),
  slaResolutionHours: z.number(),
  isActive: z.boolean(),
});

export const createCaseTypeBodySchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  slaAckHours: z.number().int().positive(),
  slaResolutionHours: z.number().int().positive(),
});

export const updateCaseTypeBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  slaAckHours: z.number().int().positive().optional(),
  slaResolutionHours: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

export const listCaseTypesQuerySchema = z.object({ categoryId: z.string().uuid().optional() });
```

- [ ] **Step 7: Add routes to src/modules/master-data/master-data.routes.ts**

```typescript
// add to imports
import { listCaseTypes, createCaseType, updateCaseType } from './case-types.service';
import { caseTypeSchema, createCaseTypeBodySchema, updateCaseTypeBodySchema, listCaseTypesQuerySchema } from './case-types.schemas';

// add inside masterDataRoutes, after the business-units routes
typedApp.get('/case-types', {
  preHandler: [app.authenticate],
  schema: { querystring: listCaseTypesQuerySchema, response: { 200: z.array(caseTypeSchema) } },
}, async (request) => listCaseTypes(app.dataSource, request.query.categoryId));

typedApp.post('/case-types', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { body: createCaseTypeBodySchema, response: { 201: caseTypeSchema } },
}, async (request, reply) => {
  const caseType = await createCaseType(app.dataSource, request.user.id, request.body);
  reply.status(201).send(caseType);
});

typedApp.patch('/case-types/:id', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { params: idParamsSchema, body: updateCaseTypeBodySchema, response: { 200: caseTypeSchema } },
}, async (request) => updateCaseType(app.dataSource, request.user.id, request.params.id, request.body));
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/master-data/case-types.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add src/modules/master-data/entities/case-type.entity.ts src/db/migrations/1700000005000-create-case-types.ts src/modules/master-data/case-types.service.ts src/modules/master-data/case-types.schemas.ts src/modules/master-data/master-data.routes.ts test/integration/modules/master-data/case-types.test.ts
git commit -m "feat: /case-types with per-type SLA hours"
```

---

## Task 25: Routing rules

**Files:**
- Create: `src/modules/master-data/entities/routing-rule.entity.ts`
- Create: `src/db/migrations/1700000006000-create-routing-rules.ts`
- Create: `src/modules/master-data/routing-rules.service.ts`
- Create: `src/modules/master-data/routing-rules.schemas.ts`
- Modify: `src/modules/master-data/master-data.routes.ts`
- Test: `test/integration/modules/master-data/routing-rules.test.ts`

**Interfaces:**
- Produces: `listRoutingRules(dataSource)`, `createRoutingRule(dataSource, actorId, input)`, `updateRoutingRule(dataSource, actorId, id, input)` — validates `targetLegalRepId` belongs to a user holding `legal_rep` or `legal_manager` (VC-07), ordered by `priorityOrder` for Phase 2's auto-routing evaluation.

- [ ] **Step 1: Write the entity**

```typescript
// src/modules/master-data/entities/routing-rule.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('routing_rules')
export class RoutingRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'jsonb' })
  matchCriteria!: Record<string, unknown>;

  @Column({ type: 'uuid' })
  targetLegalRepId!: string;

  @Column({ type: 'int', default: 0 })
  priorityOrder!: number;

  @Column({ default: true })
  isActive!: boolean;
}
```

- [ ] **Step 2: Write the migration**

```typescript
// src/db/migrations/1700000006000-create-routing-rules.ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateRoutingRules1700000006000 implements MigrationInterface {
  name = 'CreateRoutingRules1700000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'routing_rules',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'matchCriteria', type: 'jsonb' },
          { name: 'targetLegalRepId', type: 'uuid' },
          { name: 'priorityOrder', type: 'int', default: 0 },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'routing_rules',
      new TableForeignKey({ columnNames: ['targetLegalRepId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('routing_rules');
  }
}
```

- [ ] **Step 3: Write the failing test**

```typescript
// test/integration/modules/master-data/routing-rules.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function adminToken(app: ReturnType<typeof buildTestApp>) {
  return app.signAccessToken({ id: ADMIN_ID, role: 'admin', departmentId: null, entityId: null, businessUnitId: null });
}

async function createLegalRep(app: ReturnType<typeof buildTestApp>, token: string, email: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { authorization: `Bearer ${token}` },
    payload: { fullName: 'Legal Rep', email, password: 'Password123!' },
  });
  const userId = created.json().id;
  await app.inject({
    method: 'PATCH',
    url: `/users/${userId}/role`,
    headers: { authorization: `Bearer ${token}` },
    payload: { role: 'legal_rep' },
  });
  return userId;
}

describe('/routing-rules', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    for (let i = 0; i < 6; i += 1) {
      await ds.undoLastMigration();
    }
    await ds.destroy();
  });

  it('creates a routing rule targeting a legal_rep user', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);
    const legalRepId = await createLegalRep(app, token, 'rep1@algihaz.local');

    const res = await app.inject({
      method: 'POST',
      url: '/routing-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { matchCriteria: { departmentId: null }, targetLegalRepId: legalRepId, priorityOrder: 1 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().targetLegalRepId).toBe(legalRepId);

    await app.close();
  });

  it('rejects a routing rule targeting a requester (VC-07: only legal_rep/legal_manager)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);

    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Plain Requester', email: 'requester1@algihaz.local', password: 'Password123!' },
    });
    const requesterId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: '/routing-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { matchCriteria: {}, targetLegalRepId: requesterId, priorityOrder: 1 },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists routing rules ordered by priorityOrder', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const token = adminToken(app);
    const repA = await createLegalRep(app, token, 'rep2@algihaz.local');
    const repB = await createLegalRep(app, token, 'rep3@algihaz.local');

    await app.inject({ method: 'POST', url: '/routing-rules', headers: { authorization: `Bearer ${token}` }, payload: { matchCriteria: {}, targetLegalRepId: repA, priorityOrder: 5 } });
    await app.inject({ method: 'POST', url: '/routing-rules', headers: { authorization: `Bearer ${token}` }, payload: { matchCriteria: {}, targetLegalRepId: repB, priorityOrder: 1 } });

    const res = await app.inject({ method: 'GET', url: '/routing-rules', headers: { authorization: `Bearer ${token}` } });
    const order = res.json().map((r: { targetLegalRepId: string }) => r.targetLegalRepId);
    expect(order).toEqual([repB, repA]);

    await app.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test:integration test/integration/modules/master-data/routing-rules.test.ts`
Expected: FAIL — `/routing-rules` route doesn't exist (404).

- [ ] **Step 5: Write src/modules/master-data/routing-rules.service.ts**

```typescript
import type { DataSource } from 'typeorm';
import { RoutingRule } from './entities/routing-rule.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role } from '../users/entities/role.entity';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

async function assertValidLegalRep(dataSource: DataSource, userId: string): Promise<void> {
  const user = await dataSource.getRepository(User).findOne({ where: { id: userId } });
  if (!user) {
    throw new ValidationError('Unknown targetLegalRepId');
  }
  const userRole = await dataSource.getRepository(UserRole).findOne({ where: { userId } });
  const role = userRole ? await dataSource.getRepository(Role).findOne({ where: { id: userRole.roleId } }) : null;
  if (!role || (role.name !== 'legal_rep' && role.name !== 'legal_manager')) {
    throw new ValidationError('targetLegalRepId must belong to a legal_rep or legal_manager (VC-07)');
  }
}

export async function listRoutingRules(dataSource: DataSource): Promise<RoutingRule[]> {
  return dataSource.getRepository(RoutingRule).find({ order: { priorityOrder: 'ASC' } });
}

export type CreateRoutingRuleInput = {
  matchCriteria: Record<string, unknown>;
  targetLegalRepId: string;
  priorityOrder?: number;
};

export async function createRoutingRule(
  dataSource: DataSource,
  actorId: string,
  input: CreateRoutingRuleInput,
): Promise<RoutingRule> {
  await assertValidLegalRep(dataSource, input.targetLegalRepId);

  const repo = dataSource.getRepository(RoutingRule);
  const rule = await repo.save(
    repo.create({
      matchCriteria: input.matchCriteria,
      targetLegalRepId: input.targetLegalRepId,
      priorityOrder: input.priorityOrder ?? 0,
      isActive: true,
    }),
  );
  await logAuditEvent(dataSource, { actorId, action: 'routing_rule.created', afterValue: rule });
  return rule;
}

export async function updateRoutingRule(
  dataSource: DataSource,
  actorId: string,
  id: string,
  input: Partial<CreateRoutingRuleInput> & { isActive?: boolean },
): Promise<RoutingRule> {
  const repo = dataSource.getRepository(RoutingRule);
  const rule = await repo.findOne({ where: { id } });
  if (!rule) {
    throw new NotFoundError('Routing rule not found');
  }
  if (input.targetLegalRepId) {
    await assertValidLegalRep(dataSource, input.targetLegalRepId);
    rule.targetLegalRepId = input.targetLegalRepId;
  }
  const before = {
    matchCriteria: rule.matchCriteria,
    targetLegalRepId: rule.targetLegalRepId,
    priorityOrder: rule.priorityOrder,
    isActive: rule.isActive,
  };
  if (input.matchCriteria !== undefined) rule.matchCriteria = input.matchCriteria;
  if (input.priorityOrder !== undefined) rule.priorityOrder = input.priorityOrder;
  if (input.isActive !== undefined) rule.isActive = input.isActive;
  await repo.save(rule);
  await logAuditEvent(dataSource, { actorId, action: 'routing_rule.updated', beforeValue: before, afterValue: rule });
  return rule;
}
```

- [ ] **Step 6: Write src/modules/master-data/routing-rules.schemas.ts**

```typescript
import { z } from 'zod';

export const routingRuleSchema = z.object({
  id: z.string(),
  matchCriteria: z.record(z.unknown()),
  targetLegalRepId: z.string(),
  priorityOrder: z.number(),
  isActive: z.boolean(),
});

export const matchCriteriaSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    caseTypeId: z.string().uuid().optional(),
    entityId: z.string().uuid().optional(),
    businessUnitId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    priority: z.string().optional(),
  })
  .strict();

export const createRoutingRuleBodySchema = z.object({
  matchCriteria: matchCriteriaSchema,
  targetLegalRepId: z.string().uuid(),
  priorityOrder: z.number().int().optional(),
});

export const updateRoutingRuleBodySchema = z.object({
  matchCriteria: matchCriteriaSchema.optional(),
  targetLegalRepId: z.string().uuid().optional(),
  priorityOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
```

- [ ] **Step 7: Add routes to src/modules/master-data/master-data.routes.ts**

```typescript
// add to imports
import { listRoutingRules, createRoutingRule, updateRoutingRule } from './routing-rules.service';
import { routingRuleSchema, createRoutingRuleBodySchema, updateRoutingRuleBodySchema } from './routing-rules.schemas';

// add inside masterDataRoutes, after the case-types routes
typedApp.get('/routing-rules', {
  preHandler: [app.authenticate],
  schema: { response: { 200: z.array(routingRuleSchema) } },
}, async () => listRoutingRules(app.dataSource));

typedApp.post('/routing-rules', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { body: createRoutingRuleBodySchema, response: { 201: routingRuleSchema } },
}, async (request, reply) => {
  const rule = await createRoutingRule(app.dataSource, request.user.id, request.body);
  reply.status(201).send(rule);
});

typedApp.patch('/routing-rules/:id', {
  preHandler: [app.authenticate, requireRole(['admin'])],
  schema: { params: idParamsSchema, body: updateRoutingRuleBodySchema, response: { 200: routingRuleSchema } },
}, async (request) => updateRoutingRule(app.dataSource, request.user.id, request.params.id, request.body));
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test:integration test/integration/modules/master-data/routing-rules.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Run the full test suite before closing out Phase 1**

Run: `docker compose -f docker-compose.test.yml up -d && pnpm test && pnpm test:integration`
Expected: all unit and integration tests across every task in this plan PASS.

- [ ] **Step 10: Commit**

```bash
git add src/modules/master-data/entities/routing-rule.entity.ts src/db/migrations/1700000006000-create-routing-rules.ts src/modules/master-data/routing-rules.service.ts src/modules/master-data/routing-rules.schemas.ts src/modules/master-data/master-data.routes.ts test/integration/modules/master-data/routing-rules.test.ts
git commit -m "feat: /routing-rules with legal_rep/legal_manager target validation"
```

---

## Self-Review Notes

- **Spec coverage:** AC-01/02/12 (Task 8), AC-08/09 (role-gated admin routes throughout), VC-16 (Task 8 unique constraint + Task 17/19 atomic upsert), VC-18/PR-25 (Task 20), PR-24/PR-31 (Task 17), PR-26/27/28/29 (Tasks 21-25), DM-01..09 (Tasks 21-25), SE-01 (Task 9), AC-03 app-layer scoping pattern established (Task 6, applied throughout), AT-01..04 foundation (Tasks 15-16 — full case-linkage and system-wide filtering completes in Phase 2 once cases exist), UI-18 (read-open/write-admin split applied to every master-data route). AU-15/16/17 and all case/workflow/document/notification/report requirements are explicitly out of scope for Phase 1 (Phases 2-7).
- **Placeholder scan:** none — every step has concrete, runnable code.
- **Type consistency:** `AuthenticatedUser` (Task 6) is the single shape threaded through `app.signAccessToken`, `request.user`, JWT payload, and every `requireRole` check. `UserWithRole` (Task 17) is reused unchanged through Tasks 18-20. `PaginationQuery`/`paginationToSkipTake`/`buildPaginatedResponse` (Task 16) are reused verbatim by Task 18's user listing and Task 16's own audit listing.
- **Review Focus coverage:** deactivated-user login (Task 12, test 3), refresh token replay (Task 13, test 2), case-insensitive email uniqueness (Task 17, test 2), concurrent role assignment (Task 19, test 2 — via atomic upsert, not a raced read-then-write), master-data soft-deactivate never hard-delete (Task 21, test 3, and structurally — no DELETE route exists anywhere in the master-data module).

---
