# LCMS Frontend and End-to-End Integration — Final Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Algihaz LCMS: turn the `lcms-frontend` skeleton into a real React application wired to the finished backend (cookie login, role guards, every screen on live data), and prove the two work together with a seeded dev stack and end-to-end browser tests.

**Architecture:** Two repositories. `lcms-backend` gets three small additions (demo seed data, a `role`/`isActive` filter on `GET /users`, cookie auth in the OpenAPI document). `lcms-frontend` (TanStack Start + TanStack Router, run as a client-rendered SPA so the browser holds the cookies) gets: a typed API layer generated from the backend's OpenAPI document, TanStack Query hooks for every endpoint, TanStack Router `beforeLoad` guards for authentication and roles, a shadcn/ui + lucide-react shell, and one real screen per route. Cross-origin cookies work because dev frontend (`localhost:5173`) and API (`localhost:4000`) are the same *site*; production assumes sibling subdomains.

**Tech Stack:** Frontend: TanStack Start/Router 1.x, TanStack Query 5, React 19, Vite, Tailwind 4, shadcn/ui (Radix) + lucide-react, react-hook-form + zod, recharts, sonner, date-fns; tests with Vitest + Testing Library + jsdom; e2e with Playwright. Backend: Fastify 5, TypeORM, PostgreSQL, Zod 4, Vitest.

**Spec / source of truth:** There is no separate frontend spec; this plan is the design. It argues from: the BRD (as encoded in the backend), `docs/superpowers/specs/2026-10-09-frontend-integration-design.md` (cookie/CORS/CSRF and response contracts), `docs/frontend-reference/lovable-prototype-notes.md` (manager's prototype — **reference only; we are NOT copying its look**), and `docs/frontend-reference/frontend-skeleton-and-gap-analysis.md`. Decision log of the backend work: `decisions.md` section `## frontend-integration`.

## Repositories and how to run work

- Backend: `C:\vivek7\photos\photos\lcms-backend` (pnpm, branch `main`). Tasks A1–A3.
- Frontend: `C:\vivek7\photos\photos\lcms-frontend` (npm — `package-lock.json` is the lockfile in use; leave `bun.lock` alone). It is a git repo with **no commits yet**; Task B1 makes the first commit. Tasks B1–B20, C1–C3.
- Commit-message rule for **both** repos: plain text, **no `Co-Authored-By` trailer and no Claude/Anthropic attribution line**. Verify with `git log -1 --format=%B | grep -c "Co-Authored"` (must print `0`). Never push. Never stage `.archify/`, `CLAUDE.md`, `Algihaz-LCMS-Database-Schema.docx`, `Timesheet_Sep-Oct_Algihaz_Vivek.xlsx`, `docs/frontend-reference/` in the backend repo.
- Backend decisions convention still applies to A-tasks (`decisions.md` index bullet + `decisions/frontend-integration/task-NN-<slug>.md`, UTF-8, proper em dashes, edit with the editor tool; never put backticks inside a double-quoted shell string). Frontend work records decisions in `lcms-frontend/docs/decisions.md` (create in B1; one bullet per task, same discipline).

## Global Constraints

- **UI:** shadcn/ui components + `lucide-react` icons only. **No Fluent UI** (`@fluentui/*` removed in B1). **English only; no RTL/Arabic.** Own calm **blue** design (the skeleton's tokens in `src/styles.css`), not the manager's purple prototype. Inter font.
- **Router:** TanStack Router file routes only. Auth and role checks live in `beforeLoad` (route guards) **and** hide the controls in the UI. Unauthorized actions are **hidden, not disabled**.
- **Server data:** TanStack Query for **every** GET/POST/PATCH/DELETE. No axios, SWR, `useEffect`+`fetch`, or another data library. A single thin `fetch` wrapper (`src/lib/api/client.ts`) is the only place `fetch` is called.
- **Auth:** the backend sets HttpOnly cookies `lcms_access` (path `/`) and `lcms_refresh` (path `/auth`). The frontend sends `credentials: 'include'` on every request, **never stores or reads tokens** (ignore `accessToken`/`refreshToken` in the login/refresh JSON bodies; nothing in `localStorage`/`sessionStorage`). Session = `GET /auth/me`.
- **Body-less writes send `{}`:** `POST /auth/refresh`, `POST /auth/logout`, `PATCH /notifications/read-all`, and all workflow `PATCH`es without fields must be sent with `Content-Type: application/json` and body `{}` (an empty JSON body is a Fastify 400). The client does this automatically for non-GET requests without a body.
- **Errors:** backend error shape `{ error: { code, message, details? } }`; `details` is `Record<field, message>` for validation errors and is mapped onto form fields. `401` triggers exactly one refresh attempt (single-flight), then one retry; a failed refresh sends the user to `/login?redirect=<current>` and clears the Query cache.
- **Statuses (BRD, exactly five):** `Submitted`, `Assigned`, `In Progress`, `Waiting on Input`, `Closed`. **Priorities** `P1..P4` display as `Critical`, `High`, `Medium`, `Low`. **SLA states** `on_track`→`On track`, `at_risk`→`At risk`, `breached`→`Overdue`, `met`→`Met`. These mappings live only in `src/lib/labels.ts`.
- **Roles (exact keys):** `admin | legal_manager | legal_rep | requester | viewer`. Permission matrix (copied from the backend `requireRole` gates) lives only in `src/lib/permissions.ts`:
  - Nav: Dashboard, Cases, Notifications — everyone. New Request — `requester, legal_rep, admin`. Reports — `admin, legal_manager, viewer` (confirm against `REPORT_ROLES` in `reports.routes.ts` in B14). Audit — `admin, legal_manager`. Users — `admin, legal_manager` (manager read-only; only admin creates/edits). Master data — `admin`. Routing rules — `admin, legal_manager` view, `admin` edit.
  - Case actions: edit (`PATCH /cases/:id`) `requester, legal_rep, admin`; assign and change priority `legal_manager, admin`; accept and reject assignment `legal_rep, legal_manager`; escalate and close `legal_rep, legal_manager, admin`; raise information request `legal_rep`; respond to an information request: its responder; internal comments: legal roles only.
- **Confidential cases:** badge on cases with `isConfidential`; the backend already hides them (404) from viewers and unrelated requesters — the UI must treat a 404 on a case URL as "not found", never as an error to retry.
- **Dates:** responses are ISO strings. A date-only "to" filter sends end-of-day (`23:59:59.999` local → ISO) because the backend coerces a bare date to midnight UTC.
- **Clearing optional fields:** `PATCH /cases/:id` clears a field with `null`, never `""`.
- **Downloads:** documents and CSV exports need the cookie, so they are fetched with `credentials: 'include'` and saved as a blob (`downloadFile` in the client) — never a plain `<a href>`. CSV exports expose `X-Export-Total` / `X-Export-Truncated`; show a notice when truncated.
- **No SSR for app routes:** `createRouter({ defaultSsr: false })` — the server has no cookie to forward. (If `defaultSsr` does not type-check in the installed TanStack Start version, set `ssr: false` in the root route's `createRootRouteWithContext` options instead and note it in the decisions file.)
- TDD where logic exists (client, permissions, labels, guards, mappers, hooks with branching). Screens get component tests for their role-dependent behaviour plus the Playwright e2e in C1. Every task ends with `npm run lint`, `npx tsc --noEmit`, `npx vitest run` green (frontend) or `npx tsc --noEmit` + the focused vitest files + one full `pnpm test:integration` (backend).
- File-size discipline: no component file over ~300 lines; split by responsibility.

## Review Focus

- A user whose role loses a route (or whose session expired) typing the URL directly must land on `/login` or `/` — never see the screen flash. Pinned in B4, B5.
- Two requests failing with 401 at the same moment must cause **one** refresh, not two (refresh-token rotation would log the user out). Pinned in B3.
- A viewer / unrelated requester must never see confidential cases, and the UI must not show stale cached data after logout/login as another user (cache cleared on logout and on user change). Pinned in B4, C1.
- Validation errors from the backend (`details`) must land on the right form field, including the new-request form's optional intake fields where blanks must not be sent as `""`. Pinned in B9.
- Closing a case with open information requests, accepting an already-accepted case, etc. must surface the backend's message, not a generic error, and leave the UI consistent (refetch). Pinned in B11.
- Large lists/exports: pagination resets to page 1 when a filter changes; export button shows the truncation notice. Pinned in B8, B14.

---

## Decisions needed from the project owner (defaults used if unanswered)

1. **Deployment layout** — default assumed: frontend `https://app.<domain>` and API `https://api.<domain>` (sibling subdomains). Backend env then: `COOKIE_DOMAIN=.<domain>`, `COOKIE_SECURE=true`, `COOKIE_SAMESITE=lax`, `CORS_ORIGINS=https://app.<domain>`. Task C2 documents this. Changing the layout (different registrable domains) needs `SameSite=None; Secure` and is a one-line env change plus a re-test of C1 over HTTPS.
2. **Requesters uploading new versions over a lawyer's document** — default: **leave as is** (not part of this plan). If you want the restriction, it is one backend change in `documents.service.ts` plus a test; say so and it becomes task A4.
3. **Deleted comments / document names in the case audit trail** — default: **leave as is** (audit shows the full record).

---

# PART A — Backend additions (repo: `lcms-backend`)

### Task A1: Demo seed data (`pnpm seed:demo`)

The frontend and the e2e tests need a populated dev database: one user per role, org structure, and cases in each interesting state. Today only `seed:admin` exists.

**Files:**
- Create: `src/db/seed-demo.ts`
- Modify: `package.json` (script `"seed:demo": "tsx src/db/seed-demo.ts"`)
- Test: `test/integration/db/seed-demo.test.ts`
- Create: `decisions/frontend-integration/task-12-demo-seed.md`; bullet in `decisions.md`

**Interfaces:**
- Produces: `export async function seedDemo(dataSource: DataSource): Promise<{ users: Record<'admin'|'manager'|'rep1'|'rep2'|'requester'|'viewer', { id: string; email: string }>; caseIds: string[] }>` — idempotent (second run creates nothing new, returns the same ids) and refuses to run when `process.env.NODE_ENV === 'production'` (throws `Error('seed:demo must not run in production')`). A `main()` that initialises `AppDataSource`, calls it, prints the credentials table, destroys the data source.
- Consumes: existing `seedAdmin` pattern (`src/db/seed-admin.ts`), `hashPassword`, entities, `submitCase`/workflow services (use the real services so SLA dates, reference numbers and audit rows are correct — do **not** insert raw SQL into `cases`).

**Required data** (all passwords `Password123!`, emails exactly: requester `vivek@gmail.com`, admin `vivekadmin@gmail.com`, legal manager `viveklegalmanager@gmail.com`, legal reps `viveklegalrep@gmail.com` and `viveklegalrep2@gmail.com`, viewer `vivekviewer@gmail.com`):
- Users: `vivekadmin@gmail.com`, `viveklegalmanager@gmail.com` (legal_manager), `viveklegalrep@gmail.com` and `viveklegalrep2@gmail.com` (legal_rep), `vivek@gmail.com` (requester, with `departmentId`, `entityId`, `businessUnitId` set), `vivekviewer@gmail.com`. Roles come from the existing `roles` rows.
- Master data: if the migrations already seed categories / case types / departments / entities / business units / closure outcomes, reuse them; otherwise create at least: categories "Internal" and "Commercial", one case type under each, two departments, one entity with one business unit, two closure outcomes. Look up by name; create only what is missing.
- Cases (created through the real services, by the right actors): 1 `Submitted` (unassigned), 1 `Assigned` to rep1 (not yet accepted), 1 `In Progress` (accepted by rep1), 1 `Waiting on Input` (open information request raised by rep1, responder = requester), 1 escalated `In Progress`, 1 `Closed`, 1 **confidential** `Submitted`, 1 case with an SLA already breached (set `resolutionDueAt` in the past with a direct entity update after creation). Add one internal comment and one public comment on the In Progress case.

- [ ] **Step 1: Write the failing test** — call `seedDemo(ds)` twice against the test database; assert the first call yields 6 users with the 6 roles, ≥ 8 cases covering all five statuses, exactly one confidential case, one case with `slaState === 'breached'` via the service; assert the second call returns identical ids and the `cases` count is unchanged; assert `NODE_ENV=production` throws (use `vi.stubEnv`). Use `resetDatabase(ds)` first and the standard `afterAll(() => ds.undoLastMigration())`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/integration/db/seed-demo.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `seed-demo.ts` per the interface above.
- [ ] **Step 4: Run** the test — expect PASS. Then run the real script against the dev database: `pnpm migration:run && pnpm seed:demo` and again (idempotent); confirm login works: `curl -s -X POST localhost:4000/auth/login -H "Content-Type: application/json" -d '{"email":"vivek@gmail.com","password":"Password123!"}'` (dev server running) returns a user.
- [ ] **Step 5:** `npx tsc --noEmit`; full `pnpm test:integration` once. Commit: `git add src/db/seed-demo.ts package.json test/integration/db/seed-demo.test.ts decisions.md decisions/frontend-integration/task-12-demo-seed.md` / `git commit -m "feat: idempotent demo seed with one user per role and cases in every state"`.

### Task A2: Role and active filters on `GET /users`

The reassign dropdown needs "active legal reps". `GET /users` only paginates, so the frontend would have to page through everyone.

**Files:**
- Modify: `src/modules/users/users.schemas.ts` (`userListQuerySchema`), `src/modules/users/users.service.ts` (list query), `src/modules/users/users.routes.ts` (pass through)
- Test: extend `test/integration/modules/users/list-users.test.ts` (or the existing list-users test file; find it with `grep -l "GET.*/users" -r test`)
- Create: `decisions/frontend-integration/task-13-users-list-filters.md`; bullet in `decisions.md`

**Interfaces:**
- Produces: `GET /users?role=<legal_rep|…>&isActive=<true|false>&search=<text>&page&pageSize`. `role` is `z.enum(ROLE_NAMES).optional()`, `isActive` is `z.enum(['true','false']).transform(v => v === 'true').optional()`, `search` is `z.string().trim().min(1).optional()` matching `fullName` or `email` case-insensitively (`ILIKE` through the QueryBuilder, parameterised). Access unchanged (`admin`, `legal_manager`).

- [ ] **Step 1: Failing tests** — seed a legal_rep (active), a legal_rep (inactive), a requester; assert `?role=legal_rep` → 2 rows, `?role=legal_rep&isActive=true` → 1, `?search=<part of the email>` → matches case-insensitively, an invalid `role` → 400, a legal_rep caller → 403 (unchanged). Pagination `total` reflects the filters.
- [ ] **Step 2: Run** the file — expect FAIL on the filter assertions.
- [ ] **Step 3: Implement** the query filters (join `user_roles`/`roles` exactly as the existing list does; do not add a second query per row).
- [ ] **Step 4: Run** the file — PASS. `npx tsc --noEmit`; full `pnpm test:integration`.
- [ ] **Step 5: Commit** (`git add` the files above) with `feat: filter users by role, active state and search`.

### Task A3: Document cookie auth in OpenAPI and pin the contract the frontend generates types from

**Files:**
- Modify: `src/plugins/swagger.ts` (add `cookieAuth: { type: 'apiKey', in: 'cookie', name: 'lcms_access' }` to `components.securitySchemes`)
- Test: `test/integration/docs/openapi.test.ts`
- Create: `decisions/frontend-integration/task-14-openapi-cookie-scheme.md`; bullet in `decisions.md`

**Interfaces:**
- Produces: `GET /docs/json` returns an OpenAPI 3.1 document that (a) contains both `bearerAuth` and `cookieAuth` schemes, (b) contains every path the frontend uses: `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/change-password`, `/cases`, `/cases/{id}`, `/cases/{id}/audit`, `/cases/{id}/comments`, `/cases/{id}/documents`, `/cases/{id}/information-requests`, `/dashboard`, `/reports/ageing`, `/audit`, `/notifications`, `/notifications/read-all`, `/users`, `/routing-rules`, `/departments`, `/case-categories`, `/closure-outcomes`, `/entities`, `/business-units`, `/case-types`. Path-parameter style is `{id}`.

- [ ] **Step 1: Failing test** — build the app with `buildTestApp`, `GET /docs/json`, assert the scheme and the path list above.
- [ ] **Step 2: Run** — FAIL (no `cookieAuth`).
- [ ] **Step 3: Implement** the one-line scheme addition.
- [ ] **Step 4: Run** — PASS (if a listed path is absent the test shows which; that is a real gap — report it, do not delete the assertion).
- [ ] **Step 5:** `npx tsc --noEmit`; commit `feat: document cookie authentication in the OpenAPI document`.

---

# PART B — Frontend (repo: `lcms-frontend`)

Conventions used by every B task:

- Run commands from `C:\vivek7\photos\photos\lcms-frontend`. Dev server: `npm run dev` (Vite prints the port; the backend's `CORS_ORIGINS` already allows `http://localhost:5173` and `http://localhost:3000` — if Vite picks another port, add it to the backend `.env` `CORS_ORIGINS` and note it in `docs/decisions.md`).
- Backend for manual checks: from `lcms-backend`, `docker compose -f docker-compose.dev.yml up -d`, `pnpm migration:run`, `pnpm seed:demo`, `pnpm dev` (listens on `PORT=4000` from its `.env`).
- Test files live next to the unit under `src/**/__tests__/*.test.ts(x)`. Test names describe behaviour.
- After each task: `npm run lint && npx tsc --noEmit && npx vitest run`, then commit with the message given. Add one bullet to `docs/decisions.md`.

### Task B1: Repository hygiene, dependency cleanup and test tooling

**Files:**
- Create: `docs/decisions.md`, `.env.example`, `.env` (git-ignored), `vitest.config.ts`, `src/test/setup.ts`, `src/lib/__tests__/utils.test.ts`
- Modify: `package.json`, `.gitignore`, `src/router.tsx`, `src/routes/__root.tsx`
- Delete (after confirming nothing imports them): nothing yet — Fluent usage in `lcms-app.tsx` is removed in later tasks; until then `@fluentui/*` stays installed **only if** `lcms-app.tsx` still imports it. Task B20 removes the packages. To keep the app compiling now, this task only removes `SSRProvider` from the root and leaves `lcms-app.tsx` untouched.

**Interfaces:**
- Produces: `npm run test` (= `vitest run`), `src/test/setup.ts` importing `@testing-library/jest-dom/vitest`; `getRouter()` creating the router with `defaultSsr: false` and a `QueryClient` with `defaultOptions.queries = { staleTime: 30_000, retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2, refetchOnWindowFocus: false }` (import `ApiError` lazily after B3; in B1 use `retry: 1`), and `context: { queryClient }`.

- [ ] **Step 1:** `git status` — confirm `node_modules` is ignored (`.gitignore`). Add `.env` and `playwright-report/`, `test-results/` to `.gitignore` if missing. Make the **initial commit** of the untouched skeleton first: `git add -A && git commit -m "chore: initial import of the LCMS frontend skeleton"` (check `git status` shows no `node_modules`, `.env`).
- [ ] **Step 2:** Install test tooling: `npm i -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitejs/plugin-react` (skip any already present). `vitest.config.ts`: `environment: 'jsdom'`, `setupFiles: ['src/test/setup.ts']`, `globals: false`, `alias: { '@': '/src' }` (mirror `tsconfig` paths), `include: ['src/**/*.test.{ts,tsx}']`. Add `"test": "vitest run"` to `package.json` scripts.
- [ ] **Step 3: Failing test** `src/lib/__tests__/utils.test.ts`: `cn('a', false && 'b', 'c')` → `'a c'` and `cn('p-2', 'p-4')` → `'p-4'`.
- [ ] **Step 4:** Run `npx vitest run` — it must run and pass once `utils.ts` is exercised (this proves the toolchain).
- [ ] **Step 5:** `src/routes/__root.tsx`: remove `SSRProvider` and its import (leave Fluent otherwise). `src/router.tsx`: set `defaultSsr: false` and the QueryClient options above. `.env.example`: `VITE_API_BASE_URL=http://localhost:4000`; `.env` same. Create `docs/decisions.md` with `# Frontend decisions` and the first bullet.
- [ ] **Step 6:** `npm run lint && npx tsc --noEmit && npx vitest run && npm run build` — all green. Commit `chore: add test tooling, disable SSR and configure the query client`.

### Task B2: Typed API contract generated from the backend

**Files:**
- Create: `src/lib/api/schema.d.ts` (generated, committed), `src/lib/api/types.ts`, `src/lib/api/__tests__/types.test-d.ts` is **not** used (no type-test runner) — instead a compile-time check file `src/lib/api/types.check.ts` (excluded from the bundle by being unused)
- Modify: `package.json` (script `"api:types"`)

**Interfaces:**
- Produces: `npm run api:types` = `openapi-typescript http://localhost:4000/docs/json -o src/lib/api/schema.d.ts`. `types.ts` exports the helper types and named DTOs below. **Every later task imports DTOs from `@/lib/api/types`, never hand-writes response shapes.**

```ts
// src/lib/api/types.ts
import type { paths } from './schema';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;

export type ApiResponse<P extends keyof paths, M extends keyof paths[P], S extends number = 200> =
  paths[P][M] extends { responses: infer R } ? (S extends keyof R ? Json<R[S]> : never) : never;

export type ApiBody<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;

export type ApiQuery<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

export type UserRole = 'admin' | 'legal_manager' | 'legal_rep' | 'requester' | 'viewer';
export type Profile = ApiResponse<'/auth/me', 'get'>;
export type CaseDto = ApiResponse<'/cases/{id}', 'get'>;
export type CaseListDto = ApiResponse<'/cases', 'get'>;
export type CaseListQuery = ApiQuery<'/cases', 'get'>;
export type CreateCaseBody = ApiBody<'/cases', 'post'>;
export type DashboardDto = ApiResponse<'/dashboard', 'get'>;
export type CaseStatus = CaseDto['status'];
export type CasePriority = CaseDto['priority'];
export type SlaState = CaseDto['slaState'];
// … one alias per screen DTO is added by the task that first uses it (never inline-typed).
```

- [ ] **Step 1:** Start the backend (see conventions). `npm i -D openapi-typescript`. Add the script. Run `npm run api:types` — expect `schema.d.ts` generated. If generation errors on a path, record which and open an issue in `docs/decisions.md`; do not hand-edit `schema.d.ts`.
- [ ] **Step 2:** Create `types.ts` as above. Create `types.check.ts` containing assignments that fail to compile if the generated shapes drift from what the plan relies on, e.g. `const _s: CaseDto['status'] = 'Closed'; const _r: Profile['role'] = 'viewer'; const _n: CaseDto['requesterName'] = null; const _v: CaseDto['estimatedValue'] = 1;` plus `const _q: CaseListQuery = { page: 1, search: 'x' };`.
- [ ] **Step 3:** `npx tsc --noEmit` — must pass (this is the "test": the contract compiles). If `ApiQuery`'s `parameters.query` shape differs (e.g. `query?:` absent), adjust the helper until `CaseListQuery` resolves; keep the helper generic.
- [ ] **Step 4:** Commit `feat: generate typed API contract from the backend OpenAPI document`.

### Task B3: API client (cookies, single-flight refresh, errors, blobs)

**Files:**
- Create: `src/lib/api/client.ts`, `src/lib/api/errors.ts`, `src/lib/api/qs.ts`
- Test: `src/lib/api/__tests__/client.test.ts`, `src/lib/api/__tests__/qs.test.ts`
- Modify: `src/router.tsx` (use `ApiError` in the retry rule); **delete** `src/lib/lcms-api.ts` only in B20 (old screens still import `UserRole` from it — re-export `UserRole` from `types.ts` there now so both compile).

**Interfaces:**
- Produces (`errors.ts`):

```ts
export type ApiErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, string>) { super(message); }
  get isNotFound() { return this.status === 404; }
  get isForbidden() { return this.status === 403; }
}
export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError && err.details ? err.details : {};
}
```

- Produces (`qs.ts`): `export function qs(params: Record<string, string | number | boolean | undefined | null>): string` → `''` when empty, otherwise `'?a=1&b=x'`; skips `undefined`, `null` and `''`; encodes values.
- Produces (`client.ts`):

```ts
const BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/$/, '');
type Init = Omit<RequestInit, 'body'> & { json?: unknown; body?: BodyInit | null };
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null) { onSessionExpired = fn; }

let refreshing: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then((r) => r.ok).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

const NO_RETRY = ['/auth/login', '/auth/refresh', '/auth/logout'];

export async function apiFetch(path: string, init: Init = {}, retried = false): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  let body: BodyInit | null | undefined = init.body;
  if (init.json !== undefined) { body = JSON.stringify(init.json); }
  if (body === undefined && method !== 'GET' && method !== 'HEAD') { body = '{}'; }
  if (typeof body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, method, headers, body, credentials: 'include' });
  if (res.status === 401 && !retried && !NO_RETRY.some((p) => path.startsWith(p))) {
    if (await refreshSession()) return apiFetch(path, init, true);
    onSessionExpired?.();
  }
  return res;
}

async function toError(res: Response): Promise<ApiError> {
  const b = (await res.json().catch(() => null)) as ApiErrorBody | null;
  return new ApiError(res.status, b?.error?.code ?? 'UNKNOWN', b?.error?.message ?? 'The request could not be completed.', b?.error?.details);
}

export async function apiJson<T>(path: string, init: Init = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw await toError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function apiDownload(path: string, fallbackName: string): Promise<{ total?: number; truncated: boolean }> {
  const res = await apiFetch(path);
  if (!res.ok) throw await toError(res);
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name ? decodeURIComponent(name) : fallbackName });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  const total = res.headers.get('X-Export-Total');
  return { total: total ? Number(total) : undefined, truncated: res.headers.get('X-Export-Truncated') === 'true' };
}
```

- [ ] **Step 1: Failing tests** (`vi.stubGlobal('fetch', vi.fn())`, `import.meta.env` default base `''`): (a) every call passes `credentials: 'include'`; (b) a `POST` with no body sends `body: '{}'` and `Content-Type: application/json`; a `GET` sends no body; a `FormData` body gets **no** forced content type (pass `body: formData`); (c) a 401 on `/cases` triggers one `POST /auth/refresh` then one retry of `/cases`, returning the retry's result; (d) **two simultaneous 401s call `/auth/refresh` exactly once**; (e) failed refresh → `onSessionExpired` called once and the original 401 response is surfaced as `ApiError(401)`; (f) a 401 on `/auth/login` is **not** retried and not treated as expiry; (g) error mapping: `{error:{code:'VALIDATION',message:'x',details:{title:'Required'}}}` → `ApiError` with `status 400`, `code`, `details`; non-JSON error body → `code 'UNKNOWN'`; (h) 204 → `undefined`; (i) `apiDownload` creates and clicks an anchor with the `Content-Disposition` filename and returns `{ total: 5, truncated: true }` for the two headers; (j) `qs({a:1,b:'',c:undefined,d:'x y'})` → `?a=1&d=x%20y`.
- [ ] **Step 2: Run** `npx vitest run src/lib/api` — FAIL (modules missing).
- [ ] **Step 3: Implement** the three files exactly as above.
- [ ] **Step 4: Run** — PASS. `npx tsc --noEmit`, lint.
- [ ] **Step 5:** Update `router.tsx` retry rule to the final one (`!(err instanceof ApiError && err.status < 500) && n < 2`). Commit `feat: cookie-based API client with single-flight refresh and typed errors`.

### Task B4: Session, route guards and permissions

**Files:**
- Create: `src/lib/permissions.ts`, `src/lib/auth.ts`, `src/lib/guards.ts`, `src/routes/_authed.tsx`
- Rename (git mv) the existing route files into the authenticated layout: `src/routes/index.tsx`→`src/routes/_authed.index.tsx`, `cases.tsx`→`_authed.cases.index.tsx`, `cases.$caseId.tsx`→`_authed.cases.$caseId.tsx`, `new-request.tsx`→`_authed.new-request.tsx`, `reports.tsx`→`_authed.reports.tsx`, `audit.tsx`→`_authed.audit.tsx`, `rules.tsx`→`_authed.rules.tsx`, `notifications.tsx`→`_authed.notifications.tsx`, `users.tsx`→`_authed.users.tsx`, `master-data.tsx`→`_authed.master-data.tsx` (update the `createFileRoute('/…')` string in each to the new id, e.g. `'/_authed/cases/'`; `routeTree.gen.ts` regenerates on `npm run dev`/`build`). `src/routes/login.tsx` stays top-level.
- Modify: `src/routes/__root.tsx` (route context type adds nothing; provider cleanup), `src/routes/login.tsx`, `src/components/login-page.tsx`
- Test: `src/lib/__tests__/permissions.test.ts`, `src/lib/__tests__/guards.test.ts`, `src/components/__tests__/login-page.test.tsx`

**Interfaces:**
- Produces (`permissions.ts`) — the single permission matrix:

```ts
import type { UserRole } from '@/lib/api/types';
export type NavKey = 'dashboard' | 'cases' | 'new-request' | 'reports' | 'audit' | 'users' | 'master-data' | 'rules' | 'notifications';
const NAV: Record<NavKey, readonly UserRole[]> = {
  dashboard: ['admin', 'legal_manager', 'legal_rep', 'requester', 'viewer'],
  cases: ['admin', 'legal_manager', 'legal_rep', 'requester', 'viewer'],
  'new-request': ['requester', 'legal_rep', 'admin'],
  reports: ['admin', 'legal_manager', 'viewer'],
  audit: ['admin', 'legal_manager'],
  users: ['admin', 'legal_manager'],
  'master-data': ['admin'],
  rules: ['admin', 'legal_manager'],
  notifications: ['admin', 'legal_manager', 'legal_rep', 'requester', 'viewer'],
};
export const canSee = (role: UserRole, key: NavKey) => NAV[key].includes(role);
export const rolesFor = (key: NavKey) => NAV[key];
export const isLegal = (r: UserRole) => r === 'admin' || r === 'legal_manager' || r === 'legal_rep';
export const can = {
  editCase: (r: UserRole) => ['requester', 'legal_rep', 'admin'].includes(r),
  assign: (r: UserRole) => ['legal_manager', 'admin'].includes(r),
  changePriority: (r: UserRole) => ['legal_manager', 'admin'].includes(r),
  acceptOrReject: (r: UserRole) => ['legal_rep', 'legal_manager'].includes(r),
  escalate: (r: UserRole) => ['legal_rep', 'legal_manager', 'admin'].includes(r),
  close: (r: UserRole) => ['legal_rep', 'legal_manager', 'admin'].includes(r),
  raiseInfoRequest: (r: UserRole) => r === 'legal_rep',
  seeInternalComments: (r: UserRole) => ['admin', 'legal_manager', 'legal_rep'].includes(r),
  editUsers: (r: UserRole) => r === 'admin',
  editRules: (r: UserRole) => r === 'admin',
};
```

- Produces (`auth.ts`): `meQueryOptions()` = `queryOptions({ queryKey: ['me'], queryFn: () => apiJson<Profile>('/auth/me'), staleTime: 60_000, retry: false })`; `useMe()` (`useQuery(meQueryOptions())`, returns `Profile | undefined`); `useLogin()` mutation (`POST /auth/login {email,password}` → on success `queryClient.clear()` then `setQueryData(['me'], data.user)`… **use the login response `user` only if it is a full Profile; otherwise `invalidateQueries(['me'])`** — check the generated `Profile` vs the login response type in B2 and pick); `useLogout()` (`POST /auth/logout`, always `queryClient.clear()` and navigate to `/login`, even if the request fails); `useChangePassword()`.
- Produces (`guards.ts`):

```ts
import { redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { meQueryOptions } from './auth';
import { ApiError } from './api/errors';
import type { NavKey } from './permissions';
import { canSee } from './permissions';
import type { Profile } from './api/types';

export async function loadSession(queryClient: QueryClient): Promise<Profile | null> {
  try { return await queryClient.ensureQueryData(meQueryOptions()); }
  catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
}

/** pure decision used by routes and unit-tested */
export function guardDecision(me: Profile | null, key?: NavKey): { redirectTo: '/login' | '/' } | null {
  if (!me) return { redirectTo: '/login' };
  if (key && !canSee(me.role, key)) return { redirectTo: '/' };
  return null;
}

export async function requireNav(queryClient: QueryClient, location: { href: string }, key?: NavKey) {
  const me = await loadSession(queryClient);
  const d = guardDecision(me, key);
  if (d?.redirectTo === '/login') throw redirect({ to: '/login', search: { redirect: location.href } });
  if (d) throw redirect({ to: d.redirectTo });
  return me!;
}
```

- `_authed.tsx`: `createFileRoute('/_authed')({ beforeLoad: async ({ context, location }) => ({ me: await requireNav(context.queryClient, location) }), component: AppShell })` where `AppShell` is created in B5 (until then `Outlet`). Each child route that needs a role adds `beforeLoad: ({ context, location }) => requireNav(context.queryClient, location, '<navkey>')` (e.g. `_authed.reports.tsx` → `'reports'`). The login route's `beforeLoad` redirects an already-authenticated user to `search.redirect ?? '/'`; it has `validateSearch: z.object({ redirect: z.string().optional() })`.
- `login-page.tsx`: real form (react-hook-form + zod: email format, password min 8 as the skeleton had) calling `useLogin()`; on success `navigate({ to: search.redirect ?? '/' })` (only same-origin paths: accept `redirect` only if it starts with `/` and not `//`); on `401 INVALID_CREDENTIALS`-style error show the backend message; on `429` (rate limit) show "Too many attempts, try again shortly".
- Session expiry: in `__root` (or a small `SessionWatcher` inside `RootComponent`) call `setSessionExpiredHandler(() => { queryClient.clear(); router.navigate({ to: '/login', search: { redirect: router.state.location.href } }); })`.

- [ ] **Step 1: Failing tests:** `permissions.test.ts` — table test: for each of the 9 `NavKey`s and 5 roles assert `canSee` matches the matrix in Global Constraints (write the expected table literally in the test); `can.*` spot checks (viewer can do nothing; manager cannot edit a case; only `legal_rep` can raise an information request). `guards.test.ts` — `guardDecision(null, 'cases')` → login; viewer on `'audit'` → `/`; admin on `'master-data'` → null; no key + me → null; `loadSession` returns `null` on a 401 `ApiError` and rethrows a 500. `login-page.test.tsx` — wrong password shows the server message and stays on the page; success calls navigate; `redirect=//evil.com` is ignored (goes to `/`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** as specified; do the `git mv` renames and update the route ids.
- [ ] **Step 4:** `npm run build` once to regenerate `routeTree.gen.ts`; run the tests — PASS; `npx tsc --noEmit`, lint.
- [ ] **Step 5 (manual, real backend):** log in as `vivekviewer@gmail.com`, reload the page (stays signed in — cookie), open `/audit` directly (lands on `/`), log out (DevTools shows both cookies cleared), open `/cases` directly (lands on `/login?redirect=/cases`).
- [ ] **Step 6:** Commit `feat: cookie session, route guards and role permission matrix`.

### Task B5: Application shell and design system primitives

**Files:**
- Create: `src/components/layout/app-shell.tsx`, `src/components/layout/sidebar.tsx`, `src/components/layout/topbar.tsx`, `src/components/layout/user-menu.tsx`, `src/components/common/page-header.tsx`, `src/components/common/empty-state.tsx`, `src/components/common/error-state.tsx`, `src/components/common/confirm-dialog.tsx`, `src/components/common/pagination.tsx`, `src/components/common/badges.tsx`, `src/lib/labels.ts`, `src/lib/format.ts`
- Test: `src/lib/__tests__/labels.test.ts`, `src/lib/__tests__/format.test.ts`, `src/components/layout/__tests__/sidebar.test.tsx`, `src/components/common/__tests__/pagination.test.tsx`
- Modify: `src/routes/_authed.tsx` (render `AppShell`), `src/styles.css` (only if a token is missing; keep the existing blue palette)

**Interfaces:**
- Produces (`labels.ts`): `PRIORITY_LABEL: Record<CasePriority, string>` (`P1:'Critical', P2:'High', P3:'Medium', P4:'Low'`), `SLA_LABEL: Record<SlaState, string>` (`on_track:'On track', at_risk:'At risk', breached:'Overdue', met:'Met'`), `STATUS_ORDER: CaseStatus[]` (the five in workflow order), `ROLE_LABEL: Record<UserRole, string>` (`Admin, Legal Manager, Legal Representative, Requester, Viewer`), `statusTone(status)`/`priorityTone(p)`/`slaTone(s)` returning one of `'neutral'|'info'|'success'|'warning'|'danger'`.
- Produces (`format.ts`): `formatDate(iso: string | null): string` (`dd MMM yyyy`, `'—'` for null), `formatDateTime(iso)`, `formatMoney(n: number | null): string` (`SAR` thousands-separated; `'—'` for null), `endOfDayISO(date: string): string` (`YYYY-MM-DD` → ISO of that local day 23:59:59.999), `startOfDayISO`, `humanAge(hours: number): string` (`'3 d'`, `'5 h'`), `dueIn(iso): {text: string; overdue: boolean}`.
- Produces (`badges.tsx`): `<StatusBadge status/>`, `<PriorityBadge priority/>`, `<SlaBadge state/>`, `<ConfidentialBadge/>` (lucide `Lock`), `<EscalatedBadge/>` (lucide `Flame`) — shadcn `Badge` + the tone → class map.
- Produces (`pagination.tsx`): `<Pagination page pageSize total onPageChange/>` showing "1–20 of 134", prev/next, disabled at the ends, hidden when `total <= pageSize`.
- Produces: `<ConfirmDialog open title description confirmLabel destructive? pending? onConfirm onOpenChange/>` (shadcn `AlertDialog`); `<EmptyState icon title description action?/>`; `<ErrorState error onRetry/>` showing `ApiError.message` (403 → "You don't have access to this", 404 → "Not found", network → "Can't reach the server") with a Retry button; `<PageHeader title description actions/>`.
- `AppShell`: left `Sidebar` (desktop, collapsible, persisted in `localStorage` key `lcms-sidebar` inside try/catch) listing only items where `canSee(me.role, key)`, each with a lucide icon (`LayoutDashboard, FolderOpen, FilePlus2, BarChart3, ScrollText, Users, Database, GitBranch, Bell`); on `< md` the sidebar is a shadcn `Sheet` opened by a hamburger in the `Topbar`. `Topbar`: page title slot, notification bell with unread badge (data wired in B16 — in B5 render the bell without a count), `UserMenu` (name, designation, role label, "Change password" dialog hook in B6-B7 — leave a menu item that opens a dialog placeholder **component defined in this task** `change-password-dialog.tsx` using `useChangePassword`, "Sign out" → `useLogout()`). Remove the role-switcher entirely. Active link highlight via `Link`'s `activeProps`.

- [ ] **Step 1: Failing tests:** `labels.test.ts` (mappings exact, every `CasePriority`/`SlaState`/`CaseStatus` key present — use the generated unions so a backend enum change breaks the test); `format.test.ts` (null → `'—'`; `endOfDayISO('2026-03-10')` is later than `startOfDayISO('2026-03-10')` by 24h minus 1 ms; `formatMoney(1234567.5)` → `'SAR 1,234,567.50'`); `sidebar.test.tsx` — render with a mocked `me` for each role and assert the exact visible link labels per the matrix (viewer sees Dashboard, Cases, Reports, Notifications only; admin sees all nine); `pagination.test.tsx` (range text, disabled prev on page 1, hidden when it fits).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `npx tsc --noEmit`; lint.
- [ ] **Step 5 (manual):** Playwright-MCP or browser at 1280px and 390px for admin and viewer: sidebar items correct, hamburger works on mobile, no horizontal page scroll. Commit `feat: application shell, role-aware navigation and shared UI primitives`.

### Task B6: Server-state layer — lookups and the invalidation rule

**Files:**
- Create: `src/lib/queries/keys.ts`, `src/lib/queries/lookups.ts`, `src/lib/queries/invalidate.ts`
- Test: `src/lib/queries/__tests__/lookups.test.tsx`, `src/lib/queries/__tests__/invalidate.test.ts`
- Create: `src/test/render.tsx` (`renderWithProviders(ui, { me?, route? })` — a `QueryClientProvider` with a fresh client (`retry:false`) and a memory-history TanStack router for components that use `Link`; exported for all later component tests)

**Interfaces:**
- Produces (`keys.ts`): 

```ts
export const qk = {
  me: ['me'] as const,
  lookups: ['lookups'] as const,
  categories: ['lookups', 'categories'] as const,
  caseTypes: ['lookups', 'case-types'] as const,
  departments: ['lookups', 'departments'] as const,
  entities: ['lookups', 'entities'] as const,
  businessUnits: ['lookups', 'business-units'] as const,
  closureOutcomes: ['lookups', 'closure-outcomes'] as const,
  legalReps: ['lookups', 'legal-reps'] as const,
  cases: (f?: unknown) => ['cases', f ?? {}] as const,
  case: (id: string) => ['case', id] as const,
  caseAudit: (id: string, p?: unknown) => ['case-audit', id, p ?? {}] as const,
  comments: (id: string) => ['comments', id] as const,
  documents: (id: string) => ['documents', id] as const,
  documentVersions: (id: string) => ['document-versions', id] as const,
  infoRequests: (id: string) => ['info-requests', id] as const,
  dashboard: ['dashboard'] as const,
  reports: (name: string, f?: unknown) => ['reports', name, f ?? {}] as const,
  audit: (f?: unknown) => ['audit', f ?? {}] as const,
  notifications: (p?: unknown) => ['notifications', p ?? {}] as const,
  users: (f?: unknown) => ['users', f ?? {}] as const,
  routingRules: ['routing-rules'] as const,
};
```

- Produces (`lookups.ts`, all `staleTime: 5 * 60_000`, each a `useQuery` over `apiJson`): `useCategories()` (`GET /case-categories`), `useCaseTypes()` (`GET /case-types`), `useDepartments()`, `useEntities()`, `useBusinessUnits()`, `useClosureOutcomes()` (`GET /closure-outcomes`), `useLegalReps()` (`GET /users?role=legal_rep&isActive=true&pageSize=100` — enabled only when `can.assign(role)`; returns `items`), plus `nameOf(list, id)` helper. Types come from `ApiResponse<'/case-categories','get'>` etc.
- Produces (`invalidate.ts`): `invalidateCase(qc, caseId)` → invalidates `qk.case(id)`, `['cases']`, `qk.dashboard`, `['case-audit', id]`, `['notifications']`; `invalidateCaseSubresources(qc, caseId)` → `['comments', id]`, `['documents', id]`, `['info-requests', id]`, plus `invalidateCase`. **Every case-affecting mutation in B10–B13 calls one of these in `onSuccess` — never ad-hoc invalidation.**

- [ ] **Step 1: Failing tests:** `invalidate.test.ts` — spy on a `QueryClient`'s `invalidateQueries`; `invalidateCase(qc,'c1')` calls it for exactly the five key prefixes. `lookups.test.tsx` — with a stubbed `fetch`, `useLegalReps` is **not** called for a requester (no network) and is for a manager, hitting `/users?role=legal_rep&isActive=true&pageSize=100`; `nameOf` returns `'—'` for an unknown id.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint. Commit `feat: query keys, lookup hooks and shared invalidation rule`.

### Task B7: Dashboard screen

**Files:**
- Create: `src/features/dashboard/use-dashboard.ts`, `src/features/dashboard/dashboard-page.tsx`, `src/features/dashboard/tiles.tsx`, `src/features/dashboard/status-chart.tsx`, `src/features/dashboard/case-panel.tsx`, `src/features/dashboard/manager-panels.tsx`
- Modify: `src/routes/_authed.index.tsx` (renders `DashboardPage`)
- Test: `src/features/dashboard/__tests__/dashboard-page.test.tsx`

**Behaviour** (`GET /dashboard`, response `DashboardDto`):
- Tiles shown for everyone: Total, Open, Awaiting acceptance, Waiting on input, Overdue, On time, Closed. Two more for legal roles only (`isLegal(role)`): **Assigned to me** (`tiles.assignedToMe`) and **Unassigned** (`tiles.unassigned`). Each tile links to `/cases` with the replay filter from `data.filters[tileKey]` (the backend returns the exact query to replay, e.g. `filters.overdue = { slaState: 'breached', open: 'true' }`) via `<Link to="/cases" search={filters[key]}>`; the repository (B8) accepts those params.
- Status chart: recharts `BarChart` from `byStatus`, bars in `STATUS_ORDER` order with an accessible text table fallback (`sr-only`).
- Legal rep (role `legal_rep`): "My assigned cases" list from `myAssignedCases` (oldest first, ≤ 20): reference, title, status badge, priority, due text from `dueIn`; with **Accept** / **Reject** buttons on rows whose `status === 'Assigned'` (wired in B10 via the shared `AcceptRejectActions`; in B7 render them through that component imported from `@/features/case-detail/actions/accept-reject` — create a stub exporting the component signature in B7 only if B10 has not landed; the real one replaces it). Empty state: "Nothing assigned to you".
- Legal manager / admin: `managerPanels` — open caseload by rep (table: name, open, overdue; row links to `/cases?assignedLegalRepId=<id>&open=true`), Unassigned panel (count + items with an **Assign** action → opens the assign dialog from B10), Awaiting acceptance panel (items show `assignedLegalRepName`).
- Requester / viewer: tiles + chart only; no panels.
- Loading: skeleton tiles. Error: `<ErrorState>` with retry. A 403/404 never occurs here.

- [ ] **Step 1: Failing component tests** (`renderWithProviders`, stubbed fetch returning a fixture `DashboardDto` built to the generated type): requester sees 7 tiles and no "Assigned to me"; legal_rep sees 9 tiles and the "My assigned cases" list with Accept/Reject only on the `Assigned` row; manager sees the caseload table and the Unassigned panel; the Overdue tile link has `href` containing `slaState=breached`; loading shows skeletons; a 500 shows the retry button and clicking it refetches.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual, real backend, each of the 5 seeded users):** the numbers match `curl`ing `/dashboard` with that user's cookie; tile links open a correctly pre-filtered list once B8 is done (re-check there).
- [ ] **Step 6:** Commit `feat: role-aware dashboard on live data`.

### Task B8: Case repository (list, filters, search, export)

**Files:**
- Create: `src/features/cases/use-cases.ts`, `src/features/cases/cases-page.tsx`, `src/features/cases/case-filters.tsx`, `src/features/cases/cases-table.tsx`, `src/features/cases/search-params.ts`
- Modify: `src/routes/_authed.cases.index.tsx`
- Test: `src/features/cases/__tests__/search-params.test.ts`, `src/features/cases/__tests__/cases-page.test.tsx`

**Interfaces:**
- `search-params.ts` exports `casesSearchSchema` (zod): `page` (coerce int ≥1, default 1), `pageSize` (default 20), `status`, `priority`, `categoryId`, `caseTypeId`, `entityId`, `businessUnitId`, `departmentId`, `assignedLegalRepId`, `search`, `slaState`, `open` (`'true'` only) — every field optional, matching the backend `caseListQuerySchema`; invalid values are dropped via `.catch(undefined)` rather than erroring the page. The route uses `validateSearch: casesSearchSchema` so filters live in the URL (shareable, back-button safe, dashboard tile links work).
- `use-cases.ts`: `useCases(filters)` = `useQuery({ queryKey: qk.cases(filters), queryFn: () => apiJson<CaseListDto>('/cases' + qs(filters)), placeholderData: keepPreviousData })`; `useExportCases(filters)` mutation → `apiDownload('/cases/export' + qs(withoutPaging(filters)), 'cases.csv')` and toast: success "Exported N cases", truncated → warning "Export limited to the first 10,000 cases".

**Behaviour:**
- Table columns: Reference (link to `/cases/$caseId`), Title (with `ConfidentialBadge`/`EscalatedBadge`), Category/Type (`categoryName`/`caseTypeName`), Requester (`requesterName`), Assigned to (`assignedLegalRepName` or "Unassigned"), Priority badge, Status badge, SLA badge + due (`resolutionDueAt`), Created. Row click = open case. Mobile (`< md`): cards instead of table.
- Filters bar: search box (debounced 300 ms into the URL), Status, Priority, SLA state, Category, Case type (options narrowed by the chosen category), Department, Entity → Business unit (narrowed by entity), Assigned to (legal roles only — `useLegalReps` for managers; reps/admin see a "Mine" toggle that sets `assignedLegalRepId = me.id`), "Open only" toggle, "Clear filters". **Changing any filter sets `page: 1`.**
- Export button only for roles that may see data they can export: everyone who sees the list (backend scopes it). Pagination component under the table.
- Empty: "No cases match these filters" + Clear filters; error: `ErrorState`.

- [ ] **Step 1: Failing tests:** `search-params.test.ts` — `casesSearchSchema.parse({status:'Bogus', page:'2'})` → `status` dropped, `page 2`; unknown keys ignored. `cases-page.test.tsx` — typing in search updates the URL after the debounce and requests `/cases?search=…&page=1`; changing a filter while on page 3 requests page 1; a requester sees no "Assigned to" filter; clicking Export calls `/cases/export` without `page`/`pageSize` and shows the truncation warning when `X-Export-Truncated: true`; confidential case row shows the lock badge.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual):** from the dashboard click each tile → list opens pre-filtered, count equals the tile; as `vivekviewer@gmail.com` the confidential seeded case is absent; as `vivek@gmail.com` only own/department cases.
- [ ] **Step 6:** Commit `feat: case repository with URL-driven filters, search and CSV export`.

### Task B9: New request form

**Files:**
- Create: `src/features/new-request/new-request-page.tsx`, `src/features/new-request/steps/{details,parties,review}.tsx`, `src/features/new-request/schema.ts`, `src/features/new-request/use-submit-case.ts`, `src/features/new-request/attachments.tsx`
- Modify: `src/routes/_authed.new-request.tsx`
- Test: `src/features/new-request/__tests__/schema.test.ts`, `src/features/new-request/__tests__/new-request-page.test.tsx`

**Interfaces:**
- `schema.ts` exports `requestSchema` (zod 3 as installed in the frontend — note: frontend zod is v3, backend v4; do not share schemas) and `toCreateBody(values): CreateCaseBody` which: trims strings; **omits** (never sends `""`) empty optional fields (`contactName, contactEmail, contactPhone, desiredOutcome, incidentDate, businessDeadline, counterparty, thirdPartyDetails`); converts `estimatedValue` text → number or omits; sends `isConfidential` boolean; always `declarationConfirmed: true`; includes `entityId`/`businessUnitId` **only** for roles other than `requester` (the backend pre-fills them for requesters).
- Rules mirrored from the backend: `title` required; `description` ≥ 20 chars; `categoryId`, `caseTypeId`, `departmentId` required; `priority` default `P3`; `contactEmail` valid email; dates ISO `YYYY-MM-DD`; `estimatedValue` 0 … 999 999 999 999.99; max lengths (`contactName` 200, `contactPhone` 50, `counterparty` 300, `desiredOutcome`/`thirdPartyDetails` 5000); declaration checkbox must be ticked.

**Behaviour:** three guided steps (shadcn `Tabs` used as a stepper, a progress header, Back/Next; Next validates only the current step's fields):
1. **Details** — Title, Description, Category (from `useCategories()`; requesters get whatever the backend returns — do not hard-code "Internal"), Case type (narrowed by category, `useCaseTypes()` filtered by `categoryId`), Department, Priority (Critical/High/Medium/Low → `P1..P4`), Confidential toggle with helper text "Only the legal team, you and information-request responders can see this case".
2. **Parties & intake** — for requester: Entity / Business unit shown read-only from `me` (non-editable, PR-02); for `legal_rep`/`admin`: Entity and Business unit selectors (business units narrowed by entity). Optional fields: contact name/email/phone, counterparty, estimated value, incident date, business deadline, desired outcome, third-party details.
3. **Review & submit** — summary of everything, declaration checkbox, optional attachments (drag/drop + picker, client-side extension/size hint from `UPLOAD_ALLOWED_EXTENSIONS=pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt` and 25 MB — the backend is authoritative; show its error if rejected). Submit → `POST /cases`; then upload each attachment sequentially with `POST /cases/{id}/documents` (multipart field names exactly as the generated schema/`documents.routes.ts` expects — read it before coding); on full success navigate to `/cases/$caseId` with a success toast "Request CR-… submitted"; if some uploads fail, still navigate and toast "Request submitted, N attachment(s) failed — upload them from the Documents tab".
- Backend validation `details` → `form.setError(field, …)` via `fieldErrors(err)`, and jump to the step that contains the first errored field.
- Unsaved-changes guard: `useBlocker` prompts before leaving a dirty form.

- [ ] **Step 1: Failing tests:** `schema.test.ts` — blanks omitted (`toCreateBody({contactEmail:'  '})` has no `contactEmail` key); `estimatedValue '1,200.50'` → `1200.5`; requester body has no `entityId`; admin body has it; description of 19 chars fails; declaration unchecked fails. `new-request-page.test.tsx` — Next is blocked on step 1 until required fields are valid; a stubbed `400` with `details: { description: 'Too short' }` puts the error under Description and returns to step 1; successful submit posts then navigates; viewer cannot reach the route (guard) — assert via the permission matrix, not the page.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual):** as `vivek@gmail.com` submit with and without optional fields and with a 1 KB `.txt` attachment; the new case appears in the list and the dashboard "Submitted" tiles; as `vivekadmin@gmail.com` the entity/business unit selectors show.
- [ ] **Step 6:** Commit `feat: guided new-request form with intake fields, confidentiality and attachments`.

### Task B10: Case detail — overview, workflow actions, edit

**Files:**
- Create: `src/features/case-detail/use-case.ts`, `src/features/case-detail/case-detail-page.tsx`, `src/features/case-detail/case-header.tsx`, `src/features/case-detail/overview-tab.tsx`, `src/features/case-detail/actions/{accept-reject,assign,escalate,close,priority,edit-case}.tsx`, `src/features/case-detail/use-case-actions.ts`
- Modify: `src/routes/_authed.cases.$caseId.tsx` (`validateSearch: z.object({ tab: z.enum(['overview','documents','requests','comments','audit']).catch('overview') })`)
- Test: `src/features/case-detail/__tests__/use-case-actions.test.tsx`, `src/features/case-detail/__tests__/case-detail-page.test.tsx`

**Interfaces:**
- `use-case.ts`: `useCase(id)` = `useQuery({ queryKey: qk.case(id), queryFn: () => apiJson<CaseDto>(\`/cases/${id}\`), retry: (n, e) => !(e instanceof ApiError) && n < 2 })`.
- `use-case-actions.ts` — one mutation hook per action, all calling `invalidateCase(qc, id)` on success and toasting success; errors surface `ApiError.message` in a toast **and** as a returned error for dialogs:
  - `useAcceptCase(id)` → `PATCH /cases/{id}/accept` body `{}`
  - `useRejectCase(id)` → `PATCH /cases/{id}/reject` body `{ reason }` (min 3 chars)
  - `useAssignCase(id)` → `PATCH /cases/{id}/assign` body `{ targetLegalRepId }`
  - `useEscalateCase(id)` → `PATCH /cases/{id}/escalate` body `{ isEscalated: boolean, reason? }` (reason required when escalating)
  - `useCloseCase(id)` → `PATCH /cases/{id}/close` body `{ confirm: true, closureSummary, closureOutcomeId }`
  - `useChangePriority(id)` → `PATCH /cases/{id}/priority` body `{ priority }`
  - `useUpdateCase(id)` → `PATCH /cases/{id}` partial body (`null` clears)
- **Role × status action visibility (`actionsFor(me, case)` pure function in `use-case-actions.ts`, unit-tested):**
  - Accept / Reject: `can.acceptOrReject(role)` **and** `status === 'Assigned'` **and** (`role === 'legal_manager'` or `case.assignedLegalRepId === me.id`).
  - Assign / Reassign: `can.assign(role)` and `status !== 'Closed'` (label "Assign" when unassigned, "Reassign" otherwise; dialog lists `useLegalReps()`; reassigning resets acceptance — say so in the dialog).
  - Escalate / Clear escalation: `can.escalate(role)` and `status !== 'Closed'` (independent of status otherwise).
  - Close: `can.close(role)` and `status !== 'Closed'`; dialog requires outcome (`useClosureOutcomes()`), summary, and the confirm checkbox; if the backend answers with the open-information-requests conflict, show its message inline in the dialog (do not close it).
  - Change priority: `can.changePriority(role)` and `status !== 'Closed'`.
  - Edit: `can.editCase(role)` and `status !== 'Closed'` and (requester: only own case — `case.requesterId === me.id`).
  - A viewer sees no action buttons. Buttons that are not allowed are **not rendered**.
- Overview tab shows every field returned: description, category/type, department, entity/business unit, requester (name + designation), assignee (name + role), priority/status/SLA badges with due dates (`ackDueAt`, `resolutionDueAt`) and age (`humanAge(caseAgeHours)`), waiting-on reason when `waitingOnReason`, escalation reason when escalated, closure summary + outcome + who/when when closed, and the intake block (contact, counterparty, estimated value, incident date, business deadline, desired outcome, third-party details) — rows with `null` are omitted. Header: reference number, title, badges (confidential, escalated), action buttons, breadcrumb back to `/cases`. Tabs render their own components (B11–B13); in B10 the other four tabs render a lightweight "Loading…" placeholder **component file that each later task replaces** — create them as `documents-tab.tsx`, `requests-tab.tsx`, `comments-tab.tsx`, `audit-tab.tsx` returning `null` so imports are stable.
- Not found: a `404` shows a "Case not found" page with a link to the repository (also what a viewer gets for a confidential case); `403` shows "You don't have access".

- [ ] **Step 1: Failing tests:** `actionsFor` table test over (5 roles × 5 statuses × assigned-to-me/not) asserting exactly which of `accept, reject, assign, escalate, close, priority, edit` are returned (write the table out); hook tests — `useCloseCase` sends the exact body and invalidates the five key prefixes (spy), a stubbed 409 leaves the dialog open with the backend message; page tests — viewer sees no action buttons; requester sees Edit only on their own non-closed case; 404 renders "Case not found".
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual):** as `viveklegalmanager@gmail.com` assign the Submitted case to `viveklegalrep@gmail.com`; as `viveklegalrep@gmail.com` accept it (Accept/Reject disappear, status → In Progress); escalate with and without a reason (blocked without); close with an outcome (blocked while an information request is open, with the backend message); each step reflected on the dashboard without a manual refresh.
- [ ] **Step 6:** Commit `feat: case detail overview with role-aware workflow actions`.

### Task B11: Case detail — documents tab

**Files:** Create `src/features/case-detail/documents/{use-documents.ts, documents-tab.tsx, upload-dialog.tsx, versions-dialog.tsx}` (replaces the B10 stub `documents-tab.tsx`); Test `src/features/case-detail/documents/__tests__/documents-tab.test.tsx`.

**Behaviour** (read `src/modules/documents/documents.routes.ts` for the exact multipart field names, allowed categories and response shape before coding; use the generated types):
- List: `GET /cases/{id}/documents` — filename, category, version, uploaded by (`uploadedByName`), date, size; row actions: **Download** (`apiDownload('/documents/{id}/download', filename)`), **Versions** (dialog from `GET /documents/{id}/versions`, each downloadable), **Upload new version** (`POST /documents/{id}/versions`), **Delete** (`DELETE /documents/{id}`, confirm dialog; shown only to the uploader and legal roles — mirror the backend rule found in `documents.service.ts`; if the rule is not expressible client-side, show the button and surface the backend's 403 message).
- **Upload**: button + drag-and-drop → `POST /cases/{id}/documents` as `FormData` (the client must not set `Content-Type`); per-file progress states (queued/uploading/done/failed) and a retry for failures; client-side hint for extension and the 25 MB limit; backend error message shown per file. Closed cases: show uploads only if the backend allows (surface its message otherwise).
- On any success `invalidateCaseSubresources(qc, id)`.

- [ ] **Step 1: Failing tests:** upload sends `FormData` and no manual content type (assert the `fetch` call's headers); a rejected file shows the backend message on that file only while the others complete; download calls `apiDownload` with the filename; delete asks for confirmation first.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual):** upload a `.txt`, upload a new version, download both versions and compare contents, upload a disallowed `.exe` (see the backend message), delete as the right and wrong role.
- [ ] **Step 6:** Commit `feat: case documents tab with upload, versions and authenticated downloads`.

### Task B12: Case detail — information requests tab

**Files:** Create `src/features/case-detail/requests/{use-info-requests.ts, requests-tab.tsx, raise-dialog.tsx, respond-dialog.tsx}` (replaces the stub); Test `…/__tests__/requests-tab.test.tsx`.

**Behaviour** (read `information-requests.routes.ts` for exact bodies — `POST /cases/{id}/information-requests`, `POST /information-requests/{id}/respond`, `POST /information-requests/{id}/reopen`, `POST /information-requests/{id}/attachments`):
- List with status (open/answered/…), question, raised by (`raisedByName`), responder (`responderName`), dates, response text. 
- **Raise** (button only when `can.raiseInfoRequest(role)` and case not closed): question text + responder selection as the backend schema requires (use the requester as default responder if the schema allows it).
- **Respond** (button only when `me.id === request.responderId` and the request is open): response text + optional attachments (`/information-requests/{id}/attachments`).
- **Reopen** (legal_rep who raised it, per the backend's rule) on answered requests.
- Case status shows `Waiting on Input` while a request is open (that comes from the backend; the tab just invalidates via `invalidateCaseSubresources`).

- [ ] **Step 1: Failing tests:** Raise button hidden for requester/viewer/manager; Respond only for the named responder and only while open; a backend 400 shows the field message under the textarea; success invalidates `info-requests`, `case`, `cases`, `dashboard`.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual):** as `viveklegalrep@gmail.com` raise a request to `vivek@gmail.com`; as `vivek@gmail.com` respond with an attachment; status flips Waiting on Input → In Progress; closing is blocked while one is open.
- [ ] **Step 6:** Commit `feat: case information requests tab`.

### Task B13: Case detail — comments and audit tabs

**Files:** Create `src/features/case-detail/comments/{use-comments.ts, comments-tab.tsx, comment-form.tsx}`, `src/features/case-detail/audit/{use-case-audit.ts, audit-tab.tsx}` (replace the stubs); Tests `…/__tests__/comments-tab.test.tsx`, `…/__tests__/audit-tab.test.tsx`.

**Behaviour:**
- Comments: `GET /cases/{id}/comments` newest-last thread; author name (`authorName`), time, edited marker; internal notes carry an "Internal" badge. Post form: textarea + (legal roles only — `can.seeInternalComments(role)`) an "Internal note (not visible to requesters)" checkbox; requesters never see the checkbox and never see internal comments (the backend hides them; the UI additionally never renders the toggle). Edit/delete own comment (`PATCH /comments/{id}` `{ body }`, `DELETE /comments/{id}`) with confirm; show backend 403 messages.
- Audit tab: `GET /cases/{id}/audit?page&pageSize` — a timeline (actor name + role, human sentence per `action`, timestamp). Map known actions to sentences in `src/features/case-detail/audit/describe.ts` (`case.submitted`, `case.assigned`, `case.auto_assigned`, `case.accepted`, `case.waiting_on_input`, `case.resumed_in_progress`, `case.escalated`, `case.escalation_cleared`, `case.closed`, `case.updated`, `case.priority_changed`, `comment.created|edited|deleted`, `info_request.raised|answered|reopened`, `document.uploaded|version_uploaded|deleted`) with a safe fallback to the raw action string for unknown ones; unit-test `describe` with a before/after fixture per action. Pagination under the timeline. Rejection rows never appear for requesters/viewers (backend-filtered; nothing to do client-side).

- [ ] **Step 1: Failing tests:** requester sees no internal checkbox; manager does and posting sends `isInternal: true`; internal comment from the fixture renders the badge for legal roles; `describe` returns a sentence for every action above and the raw string for `weird.action`; audit tab paginates.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual):** post an internal note as `viveklegalrep@gmail.com`; confirm `vivek@gmail.com` cannot see it in the Comments tab **or** the Audit tab; reject a case (as `viveklegalrep@gmail.com`) and confirm the requester's audit shows no rejection reason.
- [ ] **Step 6:** Commit `feat: case comments and audit timeline tabs`.

### Task B14: Reports screen

**Files:** Create `src/features/reports/{use-reports.ts, reports-page.tsx, report-filters.tsx, charts/*.tsx}`; Modify `src/routes/_authed.reports.tsx`; Test `…/__tests__/reports-page.test.tsx`.

**Behaviour:** confirm the allowed roles by reading `REPORT_ROLES` in `reports.routes.ts` and reconcile `permissions.ts` (`reports`) and its test if it differs (record in decisions). Filters (shared across the five reports, URL-driven): status, priority, category, case type, entity, business unit, department, assigned rep, **created from / to** (date pickers; "to" sent as end-of-day, `from > to` shown as an inline error and not sent). Five report cards/tabs, each with a chart + a data table fallback + an Export CSV button using `apiDownload('/reports/<name>/export' + qs(filters), '<name>.csv')` (truncation notice as in B8):
1. SLA compliance (`/reports/sla-compliance`) — donut/bars of closed on time / late, open on track / at risk / breached, and the compliance percent (`null` → "No closed cases yet").
2. Ageing (`/reports/ageing`) — bars for buckets `0-7, 8-30, 31-90, 91+`.
3. Volume by category (`/reports/volume-by-category`) — grouped by category with case type.
4. Volume by organisation (`/reports/volume-by-organisation`) — entity / business unit / department table with bars.
5. Rep workload (`/reports/rep-workload`) — open, awaiting acceptance, overdue per rep.
Empty result → `EmptyState`. Each report is its own `useQuery` (parallel), so one failing report shows its own `ErrorState` without blanking the page.

- [ ] **Step 1: Failing tests:** viewer sees the page, requester is blocked by the guard (matrix); setting from > to shows the error and fires no request; export hits `/reports/ageing/export?…`; `compliancePercent: null` renders the empty text; one report 500 does not hide the others.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint.
- [ ] **Step 5 (manual):** compare each chart total with the API figure and with the exported CSV row count for `viveklegalmanager@gmail.com` and `vivekviewer@gmail.com`; confirm the confidential case is not counted for `vivekviewer@gmail.com`.
- [ ] **Step 6:** Commit `feat: reports with filters, charts and CSV export`.

### Task B15: Audit log screen

**Files:** Create `src/features/audit/{use-audit.ts, audit-page.tsx, audit-filters.tsx}`; Modify `src/routes/_authed.audit.tsx`; Test `…/__tests__/audit-page.test.tsx`.

**Behaviour:** `GET /audit` table (time, actor name + role, action, case reference link when present, summary from `describe.ts` of B13 for case actions, a generic "Changed X" fallback for user/master-data actions with a "Details" drawer showing `beforeValue`/`afterValue` JSON pretty-printed). Filters: action (free text prefix or select of known prefixes), actor, case id/reference, **created from / to** (end-of-day rule), `from > to` blocked client-side. Export button → `apiDownload('/audit/export' + qs(filters), 'audit.csv')` with the truncation notice. Roles: `admin`, `legal_manager`. Pagination resets to page 1 on filter change; the backend sorts newest first with an id tie-breaker.

- [ ] **Step 1: Failing tests:** reversed range blocked; export carries the same filters as the list; the details drawer shows JSON; requester/viewer blocked by the guard.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint. Step 5 (manual): as `vivekadmin@gmail.com` perform an action (create a user) and see it at the top with the right actor. Step 6: Commit `feat: audit log screen with date filter and export`.

### Task B16: Notifications — page, bell and unread count

**Files:** Create `src/features/notifications/{use-notifications.ts, notifications-page.tsx, notification-bell.tsx, notification-item.tsx}`; Modify `src/components/layout/topbar.tsx`, `src/routes/_authed.notifications.tsx`; Test `…/__tests__/notifications.test.tsx`.

**Behaviour** (`GET /notifications`, `PATCH /notifications/{id}/read`, `PATCH /notifications/read-all` body `{}` → `{ updated }`): the page lists notifications (title, body, time, unread dot, `relatedCaseReference` link to `/cases/$relatedCaseId`), filter All/Unread, "Mark all as read" (hidden when none unread). Clicking an item marks it read and navigates to its case. **Bell** in the topbar shows an unread count badge (`99+` cap) from a lightweight query (`GET /notifications?page=1&pageSize=1&unread=true` if the backend supports an unread filter — **check the query schema in `notifications.schemas.ts`; if not, fetch `pageSize=50` and count client-side, and note the limit in `docs/decisions.md`**) with `refetchInterval: 60_000` and `refetchIntervalInBackground: false`; a popover shows the latest 5 with "View all". Mark-read mutations use optimistic updates with rollback and invalidate `['notifications']`.

- [ ] **Step 1: Failing tests:** unread badge count and `99+`; mark-all sends `PATCH /notifications/read-all` with body `{}` and clears the badge; clicking an item marks it read once and navigates; optimistic update rolls back on a 500.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint. Step 5 (manual): as `viveklegalmanager@gmail.com` assign a case; as `viveklegalrep@gmail.com` the bell shows 1 within a minute (or after window refocus); mark read; badge clears. Step 6: Commit `feat: notifications page and live unread bell`.

### Task B17: Administration — users

**Files:** Create `src/features/users/{use-users.ts, users-page.tsx, user-form-dialog.tsx, role-dialog.tsx, reset-password-dialog.tsx}`; Modify `src/routes/_authed.users.tsx`; Test `…/__tests__/users-page.test.tsx`.

**Behaviour:** `GET /users?role&isActive&search&page` table (name, email, designation, role label, department/entity/business unit names, active toggle state). Filters: search, role, active. **Admin only** controls (`can.editUsers`): "New user" (`POST /users` — `fullName, email, password ≥ 8, designation?, phone?, departmentId?, entityId?, businessUnitId?`; blanks omitted), Edit (`PATCH /users/{id}`, `null` clears), Change role (`PATCH /users/{id}/role`), Activate/Deactivate (`PATCH /users/{id}/activate|deactivate`, confirm dialog; deactivating yourself is blocked client-side with an explanation and by the backend regardless), Reset password (`PATCH /users/{id}/reset-password` `{ newPassword }`). `legal_manager` sees the table read-only (no buttons). Duplicate email `409` → field error on Email. Success invalidates `['users']` and `['lookups','legal-reps']`.

- [ ] **Step 1: Failing tests:** manager sees no mutation buttons; admin sees them; 409 maps to the email field; self-deactivate button absent/blocked.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint. Step 5 (manual): create a user, log in as them in a private window, change their role, confirm the change applies on their next request (the backend re-reads the role each request), deactivate and confirm they are signed out on the next call. Step 6: Commit `feat: user administration`.

### Task B18: Administration — master data and routing rules

**Files:** Create `src/features/master-data/{master-data-page.tsx, simple-resource-table.tsx, entity-form.tsx, case-type-form.tsx, use-master-data.ts}`, `src/features/rules/{rules-page.tsx, rule-form.tsx, use-rules.ts}`; Modify `src/routes/_authed.master-data.tsx`, `src/routes/_authed.rules.tsx`; Test `…/__tests__/master-data-page.test.tsx`, `…/__tests__/rules-page.test.tsx`.

**Behaviour:** Master data (admin only): tabs for **Departments, Case categories, Closure outcomes** (simple `{ name, isActive }` — list, add, rename, activate/deactivate via `GET/POST/PATCH /departments|/case-categories|/closure-outcomes[/{id}]`), **Entities** and **Business units** (`/entities`, `/business-units`; business units belong to an entity — read their schemas), **Case types** (`/case-types`, belong to a category — read the schema for required fields). Duplicate name `409` → field error. Every mutation invalidates the matching `qk.*` lookup key so the new-request form sees changes immediately. Routing rules (`GET /routing-rules` for admin + manager; `POST`/`PATCH` admin): list showing which legal rep is auto-assigned for which category/type/entity/department combination as the schema defines (read `routing-rules.schemas.ts`), add/edit rule (rep selector via `useLegalReps` — admin can call `GET /users` too), activate/deactivate; manager read-only.

- [ ] **Step 1: Failing tests:** manager sees the routing rules table without buttons and cannot open Master data (guard matrix); 409 duplicate shows the field error; creating a category invalidates `['lookups','categories']`.
- [ ] **Step 2–4:** FAIL → implement → PASS; tsc; lint. Step 5 (manual): add a category + case type as `vivekadmin@gmail.com`, then open the new-request form as `vivek@gmail.com` and see them; add a routing rule and submit a matching case to see auto-assignment (`case.auto_assigned` in the audit tab). Step 6: Commit `feat: master data and routing rule administration`.

### Task B19: Profile — change password and session UX polish

**Files:** Modify `src/components/layout/change-password-dialog.tsx` (finish), `src/components/layout/user-menu.tsx`; Create `src/components/common/network-banner.tsx`; Test `src/components/layout/__tests__/change-password-dialog.test.tsx`.

**Behaviour:** `POST /auth/change-password` (read the body fields in the generated schema: current + new password, new ≥ 8); on success toast and **sign the user out** if the backend revokes sessions (check `auth.service` — if it keeps the session, stay signed in); wrong current password shows the backend message on that field. A thin top banner "You appear to be offline" using `navigator.onLine` events, and a global query error toast **only** for network failures (not for 4xx handled locally).

- [ ] **Step 1: Failing tests:** mismatched confirm blocks submit; wrong current password maps to the field; success closes the dialog. Steps 2–4 as usual; Step 5 manual: change password for a throwaway user and log in with the new one. Step 6: Commit `feat: change password dialog and offline banner`.

### Task B20: Retire the skeleton, remove Fluent, final cleanup

**Files:**
- Delete: `src/components/lcms-app.tsx`, `src/lib/lcms-data.ts`, `src/lib/lcms-context.tsx`, `src/lib/lcms-api.ts` (+ remove the temporary `UserRole` re-export)
- Modify: `package.json` (remove `@fluentui/react-components`, `@fluentui/react-icons`; remove any unused Radix packages **only if** `grep -r "@radix-ui/react-<x>" src` shows no import in `src` — shadcn components import them, so most stay), `README.md` (replace the template text with how to run), `roadmap.md` (tick the six items, add "e2e" and "deploy" items)
- Test: `src/__tests__/no-legacy.test.ts`

- [ ] **Step 1: Failing test** `no-legacy.test.ts`: walks `src/**/*.{ts,tsx}` (use `import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', eager: true })`) and asserts none contains `@fluentui`, `lcms-data`, `lcms-context`, `lcms-api`, `demoUsers`, `sessionStorage` (except the allowed `lcms-sidebar` `localStorage` key), or `Authorization`.
- [ ] **Step 2:** Run — FAIL until the legacy files are gone. **Step 3:** delete / remove as listed; fix any leftover imports.
- [ ] **Step 4:** `npm i` to refresh the lockfile; `npm run lint && npx tsc --noEmit && npx vitest run && npm run build` — all green. Record the dev cold-start time and the production bundle size in `docs/decisions.md` (the user asked why dev loading was slow; the Fluent icon bundle is the cause — note the before/after).
- [ ] **Step 5:** Commit `chore: remove the demo shell and Fluent UI`.

---

# PART C — End-to-end verification, runbook and release checks

### Task C1: Playwright end-to-end suite against the real stack

**Files (repo `lcms-frontend`):**
- Create: `e2e/playwright.config.ts`, `e2e/fixtures.ts`, `e2e/auth.spec.ts`, `e2e/workflow.spec.ts`, `e2e/visibility.spec.ts`, `e2e/admin.spec.ts`, `e2e/reports-audit.spec.ts`
- Modify: `package.json` (`"e2e": "playwright test -c e2e/playwright.config.ts"`, devDependency `@playwright/test`)

**Setup contract:** the suite assumes the backend is running on `http://localhost:4000` with a **freshly seeded** database (`pnpm migration:run && pnpm seed:demo` on a throwaway database — document the command in the spec header; recommend `lcms_e2e` DB via `DATABASE_URL` so the dev data is untouched) and the frontend on `http://localhost:5173` (`webServer` in the config starts `npm run dev`). `fixtures.ts` exports `loginAs(page, 'requester'|'manager'|'rep1'|'rep2'|'admin'|'viewer')` that fills the real login form (credentials from `seed:demo`: the six emails listed in Task A1 / `Password123!`).

**Specs (each test independent; create its own case where it mutates):**
- `auth.spec.ts`: wrong password shows the error; each role lands on the dashboard and sees exactly the matrix's nav items; reload keeps the session (cookie); sign out clears it and `/cases` redirects to `/login?redirect=…`; `viewer` opening `/audit` and `/new-request` lands on `/`; cookies are `HttpOnly` (`context.cookies()` shows `lcms_access`/`lcms_refresh` with `httpOnly: true`) and **`localStorage`/`sessionStorage` contain no token**; an expired access cookie is recovered silently (delete only `lcms_access` via `context.clearCookies({ name: 'lcms_access' })`, navigate — still signed in via refresh).
- `workflow.spec.ts` (the BRD happy path, one long test): requester submits a case with an attachment → manager sees it Unassigned, assigns to rep1 → rep1 accepts → rep1 raises an information request → requester responds → rep1 posts an internal note and a public comment → rep1 escalates with a reason → rep1 closes with an outcome → case shows Closed with summary; dashboards update; requester received notifications (bell count > 0, mark all read → 0); case audit tab lists the whole sequence.
- `visibility.spec.ts`: a confidential case submitted by the requester is invisible to `viewer` (list, direct URL → "Case not found", dashboard totals unchanged for viewer, reports) and visible to the submitter, manager and rep; `requester` never sees the internal note in Comments **or** Audit; the rejection reason (rep1 rejects an assignment) is absent from the requester's audit tab but present for the manager.
- `admin.spec.ts`: admin creates a user, a category + case type; the requester's new-request form lists the new category; admin deactivates the user and that user's next page load goes to `/login`.
- `reports-audit.spec.ts`: manager opens Reports, sets a date range, exports CSV (download event; file begins with the UTF-8 BOM and has a header row), opens Audit with a date filter and sees the workflow events; reversed range shows the inline error.

- [ ] **Step 1:** `npm i -D @playwright/test && npx playwright install chromium`. Write `fixtures.ts` and `auth.spec.ts` first.
- [ ] **Step 2:** Run `npm run e2e -- auth.spec.ts` against the seeded stack — fix real defects in the app or backend (report them; a failing e2e is a finding, not a test to loosen). Then add and run the remaining specs one at a time.
- [ ] **Step 3:** Run the whole suite twice in a row against a fresh database each time (seed is idempotent, tests create their own data) — green both times. Save `playwright-report/` output location in the decisions file (git-ignored).
- [ ] **Step 4:** Commit `test: end-to-end suite for auth, workflow, confidentiality, admin and reports`.

### Task C2: Integration runbook and environment configuration

**Files:**
- Create: `lcms-backend/docs/integration-runbook.md`, `lcms-frontend/docs/runbook.md` (short, links to the backend one)
- Modify: `lcms-backend/.env.example`, `lcms-frontend/.env.example` (comments only; no behaviour change)

**Runbook content (both required):**
1. **Local dev:** start order (docker compose dev stack → `pnpm migration:run` → `pnpm seed:demo` → `pnpm dev` (port 4000) → `npm run dev` (5173)); demo accounts table; MailHog UI URL (`http://localhost:8025` if the compose file exposes it — check `docker-compose.dev.yml`) and MinIO console; how to regenerate API types (`npm run api:types` with the backend running); how to run each test suite (`pnpm test:integration`, `npm test`, `npm run e2e`).
2. **Cookie/CORS contract:** cookie names, paths and flags; `CORS_ORIGINS` must list the frontend origin (even when same-origin); `credentials: 'include'`; CSRF rule (cookie-authenticated writes need an allowed `Origin`); refresh cookie path `/auth` means the API must be reachable at `/auth/*` (no path prefix rewrite); body-less writes send `{}`; the dev proxy is **not** used.
3. **Production layout (default assumption — decision #1):** `app.<domain>` + `api.<domain>`, HTTPS only, `COOKIE_SECURE=true`, `COOKIE_SAMESITE=lax`, `COOKIE_DOMAIN=.<domain>`, `CORS_ORIGINS=https://app.<domain>`, `JWT_ACCESS_SECRET` ≥ 32 random chars, S3 and SMTP configured (otherwise uploads/emails return 503 / are queued — startup warns), the frontend built with `VITE_API_BASE_URL=https://api.<domain>`. List what changes if the domains are unrelated (`SameSite=None; Secure`).
4. **Troubleshooting:** 403 `CSRF_BLOCKED` (missing/unlisted Origin), 401 loop (cookie domain/secure mismatch, check DevTools → Application → Cookies), CORS error on `Content-Disposition` (exposed headers list), `FST_ERR_CTP_EMPTY_JSON_BODY` (send `{}`), uploads 503 (S3 not configured), no emails (SMTP not configured; queue in `notifications`).
- [ ] **Step 1:** Write both docs from the facts above (verify each fact against the code/`.env.example`; fix any statement that is not true). **Step 2:** Follow the runbook literally on a clean shell (stop dev servers, drop and recreate the dev DB volume) and confirm the app works end to end; fix the doc where it didn't. **Step 3:** Commit in each repo: backend `docs: add the integration runbook`, frontend `docs: add the frontend runbook`.

### Task C3: Final verification, desktop/mobile pass and whole-project review

- [ ] **Step 1: Automated gates, both repos.** Backend: `npx tsc --noEmit`, `pnpm test`, `pnpm test:integration` (expect all passing, 0 failures). Frontend: `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npm run e2e`.
- [ ] **Step 2: Visual pass (roadmap item 6).** For each of the five roles at 1440×900 and 390×844: dashboard, case list, case detail (every tab), new request (all three steps), reports, audit, notifications, users, master data, rules. Check: no horizontal page scroll, nothing clipped, sidebar/hamburger behave, tables degrade to cards, every loading/empty/error state is reachable (kill the API → error states with Retry; stop the seed data → empty states). Capture screenshots into `lcms-frontend/docs/verification/` (small PNGs; commit only if < 2 MB total, otherwise list paths in the decisions file).
- [ ] **Step 3: BRD checklist.** Walk the BRD-driven rules one by one against the running app and record pass/fail in `docs/verification/brd-checklist.md`: five statuses only; status changes only through workflow actions; reassign resets acceptance; escalation independent of status; closure blocked by open information requests; internal notes hidden from requesters; unauthorized actions hidden; requester entity/business unit pre-filled and read-only; confidential rules; audit entries for every action with actor name/role; SLA badges correct for breached/at-risk/met cases.
- [ ] **Step 4: Whole-project review.** Dispatch the final reviewer (most capable model) over `git diff <first-frontend-commit>..HEAD` in the frontend and the A-task commits in the backend, focused on: token handling (nothing in JS storage), guards vs UI hiding consistency (compare `permissions.ts` against every `requireRole` in the backend), query-key/invalidation completeness, leftover `any`, accessibility of dialogs (focus trap, labels), and secrets in the repo. One fix wave; no push.
- [ ] **Step 5:** Update `roadmap.md` (all items ticked), note remaining deferred items (waiting-on reason editing UI if the backend later exposes an endpoint, priority SLA targets, 7-status model from the prototype, manager rejection at Submitted, extra dashboard widgets from the prototype) in `docs/decisions.md`, and delete the SDD workspace `lcms-backend/.superpowers/sdd/<plan-slug>/` once the review is clean.

---

## Self-review (run by the plan author)

**Spec coverage.** Every item from "what is pending" has a task: stack migration (B1, B20), real login with cookies / `/auth/me` / refresh / logout / role-switcher removal (B3–B5), route guards (B4), per-screen wiring — dashboard B7, repository B8, new request B9, case detail B10–B13, reports B14, audit B15, notifications B16, users B17, master data and rules B18, change password B19 — loading/empty/error states (B5 primitives used in every screen task), validation mapping (B3 `fieldErrors`, B9, B17, B18), label mappings (B5), hard-coded category id removal (B9 uses lookups), `.env` and git (B1), desktop/mobile (B5, C3), dev data (A1), reassign-dropdown filter (A2), OpenAPI cookie scheme (A3), end-to-end proof (C1), runbook/deployment (C2), BRD verification (C3).

**Placeholder scan.** Foundations (B1–B6) carry full code; screen tasks (B7–B19) specify files, endpoints, exact request bodies, role × status rules, test cases and manual checks rather than JSX, because the JSX follows directly from those and the shared primitives; where the plan says "read X for the exact schema" the file is named and the generated types are the authority. No "TBD".

**Type consistency.** `Profile`, `CaseDto`, `CaseListDto`, `DashboardDto`, `UserRole`, `CaseStatus`, `CasePriority`, `SlaState`, `ApiError`, `apiJson`, `apiFetch`, `apiDownload`, `qs`, `fieldErrors`, `qk.*`, `invalidateCase`, `invalidateCaseSubresources`, `canSee`, `can.*`, `isLegal`, `requireNav`, `guardDecision`, `loadSession`, `meQueryOptions`, `useMe`, `useLegalReps`, `endOfDayISO`, `formatDate`, `PRIORITY_LABEL`, `SLA_LABEL` are each defined once (B2–B6) and used under those exact names afterwards.

**Review Focus coverage.** Direct-URL guard (B4 manual + C1 auth spec), single-flight refresh (B3 test d), cache clearing and confidentiality (B4 `useLogout`/`useLogin`, C1 visibility), validation mapping (B9), backend conflict messages (B10), pagination reset and export truncation (B8, B14).

**Known risks to watch during execution.** (1) TanStack Start's `defaultSsr` option name — fallback described in Global Constraints. (2) `openapi-typescript` output for Zod-4-generated schemas (preprocess/transform) may produce `unknown` types for some fields — if so, narrow them in `types.ts`, do not hand-edit `schema.d.ts`. (3) Lovable's Vite config manages the dev port/host; if it forces a port other than 5173/3000, add it to the backend `CORS_ORIGINS`. (4) The frontend uses zod 3 and the backend zod 4 — never import one's schemas into the other.
