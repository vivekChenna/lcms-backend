# Task 8 — Durable email dispatcher with retries and backoff

**Date:** 2026-10-06

**What:**
Added `src/modules/notifications/email/email-dispatcher.ts` exporting `MAX_EMAIL_ATTEMPTS = 5`, `RETRY_DELAYS_MINUTES = [1, 5, 15, 60]` and `dispatchPendingEmails(dataSource, mailer, { batchSize? })`, which returns `{ sent, retried, failed }`. Added `test/integration/modules/notifications/email-dispatcher.test.ts` (13 tests, including a two-worker concurrency test).

**Why:**
Notification rows are the outbox: email delivery reads pending rows from the database, so a mail-server outage never loses an email and never affects the in-app notification. Each row is claimed and processed in its own short transaction using `SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED`. Concurrent workers therefore never pick the same row, and a crash can resend at most the one email that was in flight (at-least-once delivery). The send happens inside that transaction so the row stays locked while it is being mailed. Eligibility (`emailNextAttemptAt <= now()`) and backoff (`now() + interval 'N minutes'`) use the database clock, not the Node clock, so clock drift between hosts or containers cannot matter. Failed sends are retried after 1, 5, 15 and 60 minutes; after the 5th failed attempt the row is marked `failed` and is not retried again. If the recipient has been deactivated, the row is marked `failed` with `recipient inactive` and no email is sent.
