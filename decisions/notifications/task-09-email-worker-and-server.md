# Task 9 — Email worker and server wiring

**Date:** 2026-10-06

**What:**
Added `startEmailWorker({ dataSource, mailer, intervalMs?, onError? })` to `email-dispatcher.ts` (default interval 10 000 ms, returns `{ stop() }`). `src/server.ts` now creates the mailer with `createMailerFromEnv`, starts the worker after `buildApp`, and stops it first in the shutdown handler. Added `test/integration/modules/notifications/email-worker.test.ts` (4 tests).

**Why:**
The worker polls on a timer and skips a tick while a previous run is still in flight, so one process never runs two dispatches at once. A failing run is reported through `onError` and the worker keeps going. `stop()` clears the timer and waits for the in-flight run, so shutdown never abandons a half-sent email. The worker is started only by `server.ts`, never by `buildApp`, so tests drive `dispatchPendingEmails` directly. The mailer is created before the database connects so missing SMTP settings fail fast at startup.
