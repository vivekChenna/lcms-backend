# Task 14 — Document cookie authentication in the OpenAPI document

**Date:** 2026-10-10

**What:** `src/plugins/swagger.ts` now declares a `cookieAuth` security scheme (`type: apiKey`, `in: cookie`, `name: lcms_access`) next to `bearerAuth`. `test/integration/docs/openapi.test.ts` builds the app, reads `GET /docs/json`, and asserts both schemes plus every path the frontend uses (24 paths, path-parameter style `{id}`). All 24 paths were already present; none was missing or spelled differently.

**Why:** The frontend authenticates with the `lcms_access` cookie (Task 2), but the document only described the bearer scheme, so generated clients and Swagger UI had no description of the real auth mode. The frontend also generates TypeScript types from this document, so the paths it calls are pinned by a test and cannot silently disappear.

**Observation for type generation (not fixed):** `/docs/json` generates without error. For `/cases`, `/cases/{id}`, `/dashboard`, `/auth/me`, `/users`, `/notifications`, `/cases/{id}/audit` and `/reports/ageing`, every documented response has a `content` entry with a typed `application/json` schema, none is `{}`. Only 2xx responses are declared on these routes, so error bodies will be untyped in generated code. Routes whose 2xx response has no JSON schema (they return nothing or a file): `POST /auth/logout`, `POST /auth/change-password`, `PATCH /users/{id}/reset-password`, `DELETE /comments/{id}`, `DELETE /documents/{id}`, `GET /documents/{id}/download`, `GET /health`, and the `GET .../export` routes (cases, audit, and four reports). None of the eight routes above is affected.

**Not done:** Individual routes do not yet list `cookieAuth` in their own `security` requirement; only the scheme is documented, as the task specified.
