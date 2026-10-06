# Notifications — Design Spec

Status: Draft for review
Date: 2026-10-07
Parent spec: `docs/superpowers/specs/2026-09-27-lcms-backend-design.md` (§4.6, §7)
Source requirements: `20260823_Legal Case Management System - requirement vdraft2.0 (1).pdf` (BRD v1.0), section 10 (NT-01..05), AU-13, PR-06, PR-20, WF-06, AU-05, AU-07

## 1. Purpose & scope

Fourth sub-project of Phase 2 (case workflow). Delivers every notification the BRD
requires, as both an email and an in-app notification with read/unread state (NT-05),
and adds the notification calls at the points in case core and information requests
that those sub-projects deliberately left empty (case-core spec §8,
information-requests spec §9).

In scope: the `notifications` table, per-event helper functions with their recipient
rules, the call sites in the existing services, the in-app API (list, mark read), a
durable email queue with retries and its worker, the SMTP mailer, and the SLA-breach
helper (built and tested here, called by sub-project 5's job).

Out of scope (deferred): the SLA-breach scheduled job itself (sub-project 5);
notifications for documents and comments (the BRD has none); user notification
preferences or opt-out; email digests; HTML email templates; deep links into the
frontend (frontend URLs are not known yet); mark-all-read; a manual "retry failed
email" endpoint; websockets or push (the frontend polls, per the parent spec).

## 2. Decisions taken in brainstorming

| Question | Decision |
|---|---|
| Who is "the requesting department" (NT-01) | **the requester who submitted the case** (PR-06: "their cases"), not every requester in the department |
| Who is told about acceptance (AU-13 lists it, NT-01..05 do not name a recipient) | the submitting requester |
| Email delivery | **durable queue with retries**: the email state lives on the notification row and an in-process worker sends it; the in-app item never depends on email succeeding |
| In-app API | list + mark-one-read (as in the parent spec); the list response also carries the caller's `unreadCount` |

Assumptions made in this spec where the BRD is silent (flag any you disagree with):
- NT-01's "resolution and closure" is one event, because the system has a single close action.
- "The legal manager" (NT-03, PR-20) means **all active users with the `legal_manager` role**; no specific manager is assigned to a case.
- NT-02's "receipt of information responses" goes to the **case's currently assigned rep** (nobody if the case has no assigned rep).
- The requester is **not** told about information-request responses or reopens (NT-01 lists only "information request" for the requester; NT-04 covers the responder).
- Notification text carries the case reference number and title but never the case description or any document/comment text.

## 3. Structure

New module `src/modules/notifications/`:

- `entities/notification.entity.ts` — the `notifications` table.
- `notifications.events.ts` — one exported helper per event (§4). Each takes
  `DataSource | EntityManager` plus the data it needs, resolves recipients, and inserts
  one `notifications` row per recipient. The helpers hold all recipient and wording
  logic, so case core and information requests only make a one-line call.
- `notifications.service.ts` — in-app queries: list for a user, mark read.
- `notifications.routes.ts` and `notifications.schemas.ts` — the API (§6).
- `email/mailer.ts` — `interface Mailer { send(message: { to: string; subject: string; text: string }): Promise<void> }`;
  `email/nodemailer-mailer.ts` — SMTP implementation (new dependency `nodemailer`);
  `email/email-dispatcher.ts` — `dispatchPendingEmails(dataSource, mailer, options)`
  and `startEmailWorker(...)` (§5).

Dependency direction: `cases` and `information-requests` services import
`notifications.events`; `notifications` imports only entities (a leaf) and never the
services, so there is no import cycle. This mirrors how `logAuditEvent` is used.

## 4. Events and recipients

Each row below is one helper in `notifications.events.ts`; the type string is stored
in `notifications.type`.

| Helper | `type` | Recipients | Called from | BRD |
|---|---|---|---|---|
| `notifyCaseRegistered` | `case.registered` | submitting requester | `submitCase`, after the case is saved | NT-01, PR-06, AU-13 |
| `notifyCaseAssigned` | `case.assigned` | the new assignee, and the submitting requester | `assignCase` (manual assign, reassign and auto-assign all pass through it) | NT-02, NT-01, AU-05 |
| `notifyCaseAccepted` | `case.accepted` | submitting requester | `acceptAssignment` | AU-13 |
| `notifyAssignmentRejected` | `case.rejected` | all active legal managers (body includes the written reason) | `rejectAssignment` | NT-03, WF-06, PR-20, AU-07 |
| `notifyCaseClosed` | `case.closed` | submitting requester | `closeCase` | NT-01 |
| `notifyInformationRequestRaised` | `info_request.raised` | the responder, and the submitting requester | `raiseInformationRequest` | NT-04, NT-01 |
| `notifyInformationRequestAnswered` | `info_request.answered` | the case's assigned rep | `respondToInformationRequest` | NT-02 |
| `notifyInformationRequestReopened` | `info_request.reopened` | the responder | `reopenInformationRequest` | NT-04 |
| `notifySlaBreached` | `sla.breached` | all active legal managers | called by sub-project 5's job (not wired here) | NT-03 |

Recipient rules common to all helpers:
- A user appears at most once per event: if the same person is, say, both the
  submitter and the responder, they receive one notification. Recipients are taken in
  the order §4 lists them (assignee or responder before the requester), and the first
  match supplies the text.
- Inactive users (`isActive = false`) never receive notifications.
- A recipient that does not exist (for example an unassigned case's missing rep) is
  skipped silently; a helper never throws because a recipient is absent. A case with
  no active legal manager simply produces no manager notifications.
- Recipient-specific wording is allowed: for `case.assigned` the assignee sees "A case
  has been assigned to you" and the requester sees "Your case has been assigned to a
  legal representative".
- Title and body are plain text built from the case reference number and title (and,
  for rejection, the reason). No description, no document or comment content.

## 5. Data model and email delivery

### `notifications`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| userId | uuid FK → users, NOT NULL | the recipient |
| type | varchar | one of the §4 types |
| title | varchar | also the email subject |
| body | text | also the email body |
| relatedCaseId | uuid FK → cases, nullable | |
| isRead | boolean, default false | |
| readAt | timestamptz, nullable | set the first time it is read |
| createdAt | timestamptz | |
| emailStatus | varchar, default `pending` | `pending` \| `sent` \| `failed` |
| emailAttempts | integer, default 0 | |
| emailNextAttemptAt | timestamptz | when the next send may be tried; defaults to `now()` |
| emailSentAt | timestamptz, nullable | |
| emailLastError | text, nullable | the last send error message |

Indexes: `(userId, isRead, createdAt)` for the in-app list; `(emailNextAttemptAt)`
partial on `emailStatus = 'pending'` for the worker. FKs use RESTRICT. One migration,
`1700000013000-create-notifications.ts`.

### Writing notifications

The helpers write their rows with whatever `DataSource | EntityManager` the caller
holds. Where the calling function already runs in a transaction (`closeCase`, raise,
respond, reopen), the notification rows commit or roll back with the action. Where it
does not (`submitCase`, `assignCase`, `acceptAssignment`, `rejectAssignment`), the
rows are written immediately after the action, the same consistency level as
`logAuditEvent` has there today. A rolled-back action never leaves a notification.

### Email worker

`dispatchPendingEmails(dataSource, mailer, options)` sends pending emails:
1. Repeatedly, in its own short transaction, claim one row with
   `emailStatus = 'pending' AND emailNextAttemptAt <= now()` ordered by `createdAt`,
   `FOR UPDATE SKIP LOCKED`, up to `batchSize` (10) rows per call. Because each row has
   its own transaction, two workers never send the same row, and a crash can duplicate
   at most the one email that was in flight (at-least-once delivery).
2. Look up the recipient's email address from `users`, and call `mailer.send` with
   `to`, `subject = title`, `text = body`.
3. On success: `emailStatus = 'sent'`, `emailSentAt = now()`, `emailAttempts += 1`.
4. On failure: `emailAttempts += 1`, `emailLastError = <message>`. After the 1st, 2nd,
   3rd and 4th failure `emailNextAttemptAt` moves out by 1, 5, 15 and 60 minutes; after
   the 5th failure `emailStatus = 'failed'` (no further retries).
5. A recipient who has become inactive since the notification was created is not
   emailed: the row is marked `failed` with `emailLastError = 'recipient inactive'`
   and no send is attempted.

`startEmailWorker(app, deps)` runs `dispatchPendingEmails` every 10 seconds with
`setInterval`, never overlaps two runs in one process, logs errors without crashing,
and is stopped in `server.ts`'s shutdown handler. It is started only by `server.ts`,
never by `buildApp`, so tests control dispatch explicitly by calling
`dispatchPendingEmails` with a fake mailer.

### Mailer and configuration

`NodemailerMailer` uses SMTP with connection and socket timeouts (10 s / 15 s). New env
settings, validated at boot like the S3 settings: `SMTP_HOST`, `SMTP_PORT` (default
1025), `SMTP_SECURE` (default false), `SMTP_USER` and `SMTP_PASSWORD` (both optional),
`MAIL_FROM`. `server.ts` fails at startup with a clear message if `SMTP_HOST` or
`MAIL_FROM` is missing. `.env.example` gains the dev values for MailHog
(`SMTP_HOST=localhost`, `SMTP_PORT=1025`, `MAIL_FROM=lcms@algihaz.local`).

## 6. In-app API

Both routes require authentication and return only the caller's own notifications,
for any role (a viewer included).

- `GET /notifications?isRead=true|false&page=&pageSize=` — newest first, standard
  pagination (`paginationQuerySchema`). The response is the usual
  `{ items, total, page, pageSize }` plus `unreadCount`: the caller's total unread
  count, independent of the `isRead` filter. Each item has `id`, `type`, `title`,
  `body`, `relatedCaseId`, `isRead`, `readAt`, `createdAt`; the email fields are not
  exposed.
- `PATCH /notifications/:id/read` — marks one notification read and returns it.
  Idempotent: reading an already-read notification returns it unchanged (`readAt`
  keeps its original value). Another user's notification, or an unknown id, is 404.

There is no audit entry for creating or reading a notification (a system side effect,
not a business event).

## 7. Call sites in existing code

The edits to shipped code are single calls added after the action's audit call:
`submitCase` and `assignCase`/`acceptAssignment`/`rejectAssignment` in
`src/modules/cases/cases.service.ts` and `cases.workflow.service.ts`; `closeCase` in
`cases.workflow.service.ts`; and `raiseInformationRequest`,
`respondToInformationRequest`, `reopenInformationRequest` in
`src/modules/information-requests/information-requests.service.ts`. No existing
signature, authorization rule, status code or audit entry changes.

## 8. Test infrastructure changes

- `test/integration/helpers/reset-db.ts` gains `notifications` ahead of `cases` and
  `users` (it references both).
- A `RecordingMailer` fake in `test/integration/helpers/` (records messages; can be
  told to fail N times or always).
- Fixture helper `seedNotification` and, for the existing event tests, a small helper
  to read a user's notifications.

## 9. Testing

- One integration test per event helper through the real endpoint that triggers it:
  the correct recipients receive exactly one notification each with the expected type
  and related case, nobody else does, text contains the case reference number and
  not the description. Covers assignment via manual assign, reassign and auto-routing
  on submit (the requester gets registration then assignment; the assignee gets
  assignment), rejection reaching every active legal manager (and none when there are
  none), and the reason appearing in the manager text.
- Recipient rules: de-duplication (requester who is also the responder gets one),
  inactive users skipped, case without an assigned rep produces no "answered"
  notification.
- Atomicity: a failed action (for example closing a case that has an open information
  request) leaves no notification.
- API: list is own-only and newest first; `isRead` filter; pagination; `unreadCount`
  ignores the filter; mark-read sets `readAt` once and is idempotent; another user's
  notification is 404; a viewer can list and mark read.
- Email dispatcher with the fake mailer: success marks `sent`; a failure schedules the
  retry with the documented backoff and keeps the error; the 5th failure marks
  `failed`; a row whose next-attempt time is in the future is not sent; two concurrent
  `dispatchPendingEmails` calls send each email exactly once; an inactive recipient is
  not emailed; the in-app notification is unaffected by any email outcome.
- `NodemailerMailer` has an opt-in smoke test against MailHog (skipped by default),
  like the S3 smoke test.
- Review Focus (inputs that would bite a real user): a recipient whose notification
  text contains special characters in the case title (quotes, newlines, non-ASCII) must
  produce a valid email subject with no header injection; a very long case title; the
  requester and the assignee being the same person; a case that is reassigned twice
  producing the right recipients each time; notifications for a user who is later
  deactivated.

## 10. Requirement traceability (spot-check)

NT-01..NT-04 and AU-13 (§4); NT-05 (§5, §6); PR-06 (§2, §4); PR-20, WF-06, AU-07
(rejection row); AU-05 (assignment row); NT-03 SLA breach (`notifySlaBreached`, called
by sub-project 5). Document and comment events have no BRD notification and are not
notified.
