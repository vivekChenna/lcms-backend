# Task 1 — Do not crash on missing S3 or SMTP configuration

**Date:** 2026-10-08

**What:** `server.ts` no longer exits when S3 or SMTP settings are missing. Missing or unreachable S3 logs a warning and uses `UnavailableObjectStorage`, whose operations fail with a 503 `SERVICE_UNAVAILABLE` error. Missing SMTP logs a warning and does not start the email worker, so notification emails stay queued (in-app notifications are unaffected) and are sent once SMTP is configured and the server restarts. A new `ServiceUnavailableError` (503) was added.

**Why:** `pnpm dev` crashed with "S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set" on a machine without MinIO configured, although the rest of the API does not need it. The factory functions still throw when called without config (their tests are unchanged); only the startup code decides to continue. A database that is unreachable still stops startup, because nothing works without it.
