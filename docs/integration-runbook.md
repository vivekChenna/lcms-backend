# Integration runbook — running the LCMS backend with the frontend

How to bring up the whole stack (Postgres, S3 object storage, MailHog, backend, frontend) on a clean machine
and confirm it works end to end. Commands are for a POSIX-style shell; on Windows use Git Bash.

## Prerequisites

- Node 20+ (the AWS SDK prints a warning on Node 20; it asks for Node 22+ from January 2027 — upgrade then).
- pnpm for the backend, npm for the frontend.
- Docker (Docker Desktop on Windows must be running).

## 1. Infrastructure

From `lcms-backend`:

```bash
docker compose -f docker-compose.dev.yml up -d
```

| Service  | Port(s)        | Purpose / login                                           |
|----------|----------------|-----------------------------------------------------------|
| Postgres | 5442           | database `lcms_dev`, user `lcms`, password `lcms`         |
| S3 (RustFS) | 9000 / 9001 | document storage; console http://localhost:9001/rustfs/console/, `lcms` / `lcms12345` |
| MailHog  | 1025 / 8025    | catches outgoing email; inbox http://localhost:8025       |

The backend creates the `lcms-documents` bucket itself when it starts; nothing to set up by hand.

**Why RustFS and not MinIO.** The dev stack used MinIO until its official images were removed from
Docker Hub and Quay, so the pinned image can no longer be pulled on a fresh machine. The backend only
uses the standard S3 API (path-style addressing), so any S3-compatible server works; RustFS is an
Apache-2.0 drop-in on the same ports with the same credentials. Production only needs an S3 endpoint
and the `S3_*` values below.

**Docker data.** The database and the stored documents live in Docker volumes (`lcms_pg_dev`,
`lcms_s3_dev`). Resetting or reinstalling Docker Desktop deletes them; rebuild with the migration and
`pnpm seed:demo` steps in section 2.

## 2. Backend

```bash
cd lcms-backend
cp .env.example .env        # first time only
pnpm install
pnpm migration:run
pnpm seed:demo              # idempotent: one user per role plus cases in every state
pnpm dev                    # http://localhost:4000
```

**Port.** `.env.example` says `PORT=3000`, but the frontend defaults to `http://localhost:4000`.
Either set `PORT=4000` in `.env` (what this project does) or change `VITE_API_BASE_URL` in the frontend.

**Frontend address.** `FRONTEND_URL` is the address people open the app on; every invitation and
password-reset email links to `${FRONTEND_URL}/set-password?token=...`. It must be reachable by the
recipient (in production, the real hostname, not `localhost`). Without it the backend logs a warning
at startup and reports invitation emails as not sent.

**CORS.** `CORS_ORIGINS` must list the exact origin the frontend is served from, including the port.
If it does not, the browser blocks every API call and the app shows "This page didn't load".
Vite uses 5173 and falls back to 5174, 5175… when the port is taken, so check the address it prints.
Restart the backend after editing `.env` — it is only read at startup.

Check it is up: `curl http://localhost:4000/health` returns `{"status":"ok"}`. API docs: http://localhost:4000/docs.

## 3. Frontend

```bash
cd lcms-frontend
cp .env.example .env        # VITE_API_BASE_URL=http://localhost:4000
npm install
npm run dev                 # http://localhost:5173
```

## 4. Demo accounts

The seeded demo accounts all use the password `Password123!` (they are created directly, not invited).
Any account an admin adds through the app has **no password**: the person gets an email with a link,
valid for 48 hours and usable once, and chooses their own. In development that email appears in MailHog
(http://localhost:8025). An admin can resend the link from the users table, and anyone can use
"Forgot password?" on the sign-in page.

| Role                | Email                          |
|---------------------|--------------------------------|
| Requester           | vivek@gmail.com                |
| Legal manager       | viveklegalmanager@gmail.com    |
| Legal rep           | viveklegalrep@gmail.com        |
| Legal rep (second)  | viveklegalrep2@gmail.com       |
| Admin               | vivekadmin@gmail.com           |
| Viewer              | vivekviewer@gmail.com          |

Login is limited to 5 attempts per minute per IP and email. "Too many attempts" means wait a minute.

## 5. Smoke test

1. Sign in as the requester, open **New Request**, submit a case with an attachment.
   The attachment lands in the object store (console → `lcms-documents` → `cases/`).
2. Sign in as the manager (separate browser profile or private window), open the case, **Assign** it to a legal rep.
3. Sign in as the legal rep, **Accept** it. The requester receives an in-app notification and an email in MailHog.
4. Sign in as the viewer: the case list and dashboard totals must not include confidential cases.

## 6. Automated checks

```bash
# backend (from lcms-backend)
pnpm exec tsc --noEmit
pnpm test
pnpm test:integration

# frontend (from lcms-frontend)
npm run lint && npx tsc --noEmit && npm test && npm run build
```

### End-to-end suite

The Playwright suite mutates data and expects a **freshly seeded throwaway database**, never `lcms_dev`.
From `lcms-backend`, with Docker up:

```bash
docker exec <postgres-container> psql -U lcms -d postgres -c "CREATE DATABASE lcms_e2e"
DATABASE_URL=postgres://lcms:lcms@localhost:5442/lcms_e2e pnpm migration:run
DATABASE_URL=postgres://lcms:lcms@localhost:5442/lcms_e2e pnpm seed:demo
DATABASE_URL=postgres://lcms:lcms@localhost:5442/lcms_e2e pnpm dev     # keep running on :4000
```

Then, from `lcms-frontend`: `npm run e2e` (it starts a Vite server on 5173, or reuses one already running there).
The HTML report is written to `lcms-frontend/playwright-report/`; screenshots to `lcms-frontend/e2e/screenshots/`.
Rebuild the database (`DROP DATABASE lcms_e2e WITH (FORCE)`, then the steps above) before each full run.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "This page didn't load" / "Can't reach the server" | Backend down, wrong `VITE_API_BASE_URL`, or the frontend origin is missing from `CORS_ORIGINS`. |
| Cookie-authenticated writes return 403 `CSRF_BLOCKED` | `CORS_ORIGINS` is empty or lacks the frontend origin. |
| `EADDRINUSE` on 4000 | Another backend is running (check for one pointed at `lcms_e2e`). Stop it first. |
| Backend fails at startup connecting to Postgres | Docker is not running, or `docker compose up -d` was not run. |
| Uploads fail | The S3 container is not running, or `S3_*` values in `.env` differ from the compose file. |
| `docker compose up` cannot pull an image | A pinned image was withdrawn upstream (this happened to MinIO). Pick a published S3-compatible image and keep ports 9000/9001 and the `lcms` / `lcms12345` credentials. |
| Docker Desktop reports "Lingering processes detected" | Old Docker processes survived a crash. Choose "Stop processes" in that dialog, then start Docker again. |
| No emails | MailHog not running; `SMTP_HOST`/`SMTP_PORT` must be `localhost`/`1025`. |
