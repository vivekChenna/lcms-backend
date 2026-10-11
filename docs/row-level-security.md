# Row-level security

BRD AC-03: *all access rules shall be enforced server-side at the database layer (row-level security),
not only in the UI.* This is how that is done, and how to run and extend it.

## What is protected

Postgres decides which rows a user may read or write in these tables:

| Table | Who sees a row |
| --- | --- |
| `cases` | legal representative, legal manager, admin: all. Viewer: non-confidential. Requester: their own cases, their department's non-confidential cases, and any case they have been asked an information request on |
| `documents`, `information_requests` | whoever sees the case |
| `comments` | whoever sees the case; internal notes (`isInternal`) only legal staff (AC-10) |
| `audit_log` | whoever sees the case, plus a person's own entries, plus account-level entries (no case) for managers and admins |

Writes: a viewer, or anyone unknown, cannot insert or update any of them. Nothing can update or delete
an `audit_log` row at all (it is append-only, enforced by privileges as well as by policy).

Not covered, on purpose: `users`, `user_roles`, `roles`, `refresh_tokens`, `password_links` and the master
data (the API has to read them before it knows who is asking), and `notifications` (one row per
recipient, written by someone else, so a policy on reading would reject the sender's own insert).

## How it works

1. **A restricted role.** Migration `1700000016000` creates `lcms_app` (NOLOGIN, no superuser, no
   BYPASSRLS), grants it table privileges, and grants it to the connecting user so that user may
   `SET ROLE lcms_app`.
2. **Policies** on the tables above call small SQL functions (`app_current_role()`,
   `app_case_visible(...)`, …). The user's role and department are read from `users` / `user_roles`
   inside the database, never from a value the application sends. The only thing the application
   supplies is the user id, `app.user_id`.
3. **Every request** runs in its own context (`src/db/request-context.ts`, an `AsyncLocalStorage`).
   The `onRequest` hook creates it with no user; `app.authenticate` fills in the user once the access
   token is verified. A request that never authenticates sees nothing in the protected tables.
4. **Every connection checkout** (`src/db/row-level-security.ts`) writes that user onto the pooled
   connection and switches it to `lcms_app`. The user is captured when the connection is *requested*,
   not when it is handed over, so a request queued behind others cannot inherit someone else's identity.
5. **Outside a request** (background workers, seeds, migrations, scripts) there is no context, so queries
   run with the connection's own privileges and are not restricted. The tables are not `FORCE`d.

## Running it

- **Apply the migration** (`pnpm migration:run`). Until then the server starts, logs
  `Row-level security is NOT active`, and enforces access in the API only. With `NODE_ENV=production` it
  refuses to start without the migration.
- **No new credentials are needed**: the usual `DATABASE_URL` user does `SET ROLE lcms_app`. That user
  must be able to (the migration does `GRANT lcms_app TO CURRENT_USER`). If the application connects as a
  different user from the one that ran the migration, run `GRANT lcms_app TO <that user>`.
- **The connecting user must not be the only protection.** A database superuser, or any role with
  BYPASSRLS, ignores policies. `lcms_app` is what is restricted, and the application only gets it by
  `SET ROLE`.

## Extending it

- **A new table that holds case data**: enable RLS, add a `SELECT` policy `USING (app_can_see_case("caseId"))`
  and `INSERT`/`UPDATE` policies with `app_can_write()`. Without a policy for a command, the restricted role
  cannot run it.
- **A new flow that writes an audit row for someone who is not signed in** (a one-time link, say): call
  `setRequestUser(thatUserId)` first, as `password-links.ts` does, so the audit row is visible to its actor.
  (A row you insert must also be visible to you: Postgres checks `RETURNING` against the read policy.)
- **A new role**: add it to `app_case_visible`, `app_can_write` and `app_is_legal`.
- **Work done on behalf of the system inside a request**: wrap it in `runAsSystem(...)`.

## Tests

- `test/integration/security/row-level-security.test.ts` talks to Postgres as `lcms_app` with no
  application code: who sees which case, document, comment and audit row, and who may write.
- `test/integration/security/row-level-security-api.test.ts` drives real HTTP requests at a probe route that
  does **not** filter, with a two-connection pool and 70 concurrent requests, to prove each request sees only
  what its user may see and that identities do not leak between requests.
- `buildTestApp` installs row-level security for every other HTTP test, so the whole API suite runs under it.

## Limits to know

- This is defence in depth for *reads and writes of case data*. A SQL-injection flaw could still run
  `RESET ROLE`; the answer to that is not having one (all queries are parameterised).
- The policies decide row visibility. Field-level rules (for example, a viewer not seeing a requester's phone
  number) remain the API's job.
- A policy is evaluated for every row a query touches. The functions are `STABLE` and the tables small, so
  this is cheap today; if the repository grows to millions of cases, look at the plan for `cases` first.
