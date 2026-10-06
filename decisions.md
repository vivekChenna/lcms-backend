# Decisions log

Index of why each meaningful change was made. One file per task/feature under `decisions/<feature>/`; this file just links to them, newest first.

---

## notifications (Phase 2, sub-project 4)

- [Task 9 — Email worker and server wiring](decisions/notifications/task-09-email-worker-and-server.md)
- [Task 8 — Durable email dispatcher with retries and backoff](decisions/notifications/task-08-email-dispatcher.md)
- [Task 7 � In-app notification API](decisions/notifications/task-07-in-app-api.md)
- [Task 6 — Wire information-request actions to notifications](decisions/notifications/task-06-information-request-wiring.md)
- [Task 5 — Wire case actions to notifications](decisions/notifications/task-05-case-action-wiring.md)
- [Task 4 — Information-request notification event helpers](decisions/notifications/task-04-information-request-event-helpers.md)
- [Task 3 — Case lifecycle notification event helpers](decisions/notifications/task-03-case-event-helpers.md)
- [Task 2 — Notification entity, migration, reset helper, fixtures](decisions/notifications/task-02-entity-migration-fixtures.md)
- [Task 1 — SMTP config, Nodemailer mailer, recording mailer fake](decisions/notifications/task-01-smtp-config-and-mailer.md)

## documents-comments (Phase 2, sub-project 3)

- [Final review fixes — multipart limits, .env.example, deterministic race test, hardening](decisions/documents-comments/final-review-fixes.md)
- [Task 10 — Document soft delete](decisions/documents-comments/task-10-document-delete.md)
- [Task 9 — Information-request attachments](decisions/documents-comments/task-09-information-request-attachments.md)
- [Task 8 — Upload a new version](decisions/documents-comments/task-08-new-version.md)
- [Task 7 — Document list, version history, streamed download](decisions/documents-comments/task-07-list-versions-download.md)
- [Task 6 — Case document upload (streamed, validated, transactional)](decisions/documents-comments/task-06-case-document-upload.md)
- [Task 5 — Comment edit and delete (author-only, soft delete)](decisions/documents-comments/task-05-comment-edit-delete.md)
- [Task 4 — Case write-eligibility helper, comment create and list](decisions/documents-comments/task-04-comment-create-list.md)
- [Task 3 — Entities, migration, reset helper, fixtures](decisions/documents-comments/task-03-entities-migration-fixtures.md)
- [Task 2 — Storage layer, app wiring, test helpers](decisions/documents-comments/task-02-storage-layer.md)
- [Task 1 — Upload environment config, file validation rules, and 413 error](decisions/documents-comments/task-01-config-and-upload-rules.md)

## information-requests (Phase 2, sub-project 2)

- [Closed the parked finding: closeCase now locks the case row](decisions/information-requests/closecase-row-lock.md)
- [Task 9 — Closure guard: no open information requests (VC-12)](decisions/information-requests/task-09-closure-guard.md)
- [Task 8 — Requester-as-responder visibility extension (case core)](decisions/information-requests/task-08-responder-visibility.md)
- [Task 7 — List information requests for a case](decisions/information-requests/task-07-list.md)
- [Task 6 — Reopen an information request](decisions/information-requests/task-06-reopen.md)
- [Task 5 — Respond to an information request](decisions/information-requests/task-05-respond.md)
- [Task 4 — Raise an information request](decisions/information-requests/task-04-raise.md)
- [Task 3 — Case-transition helpers (markCaseWaitingOnInput / markCaseInProgress)](decisions/information-requests/task-03-case-transition-helpers.md)
- [Task 2 — Information-request Zod schemas](decisions/information-requests/task-02-schemas.md)
- [Task 1 — InformationRequest entity, migration, and test fixtures](decisions/information-requests/task-01-entity-migration-fixtures.md)

## case-core (Phase 2, sub-project 1)

- [Final review fix wave — VC-03/04 edit bypass, legal_manager accept/reject, closure validation, test isolation](decisions/case-core/final-review-fixes.md)
- [Task 14 — Priority changes](decisions/case-core/task-14-priority-change.md)
- [Task 13 — General edit](decisions/case-core/task-13-general-edit.md)
- [Task 12 — Closure](decisions/case-core/task-12-closure.md)
- [Task 11 — Escalation](decisions/case-core/task-11-escalation.md)
- [Task 10 — Listing and detail (visibility matrix)](decisions/case-core/task-10-list-and-get.md)
- [Task 9 — Case submission](decisions/case-core/task-09-submit-case.md)
- [Task 8 — Accept and reject](decisions/case-core/task-08-accept-reject.md)
- [Task 7 — Assignment (and reassignment)](decisions/case-core/task-07-assign-reassign.md)
- [Task 6 — Case schemas](decisions/case-core/task-06-case-schemas.md)
- [Task 5 — Auto-routing matcher](decisions/case-core/task-05-auto-routing-matcher.md)
- [Task 4 — SLA due-date computation and live state derivation](decisions/case-core/task-04-sla-helpers.md)
- [Task 3 — Placeholder case reference number generator](decisions/case-core/task-03-reference-number-generator.md)
- [Task 2 — Case status state machine](decisions/case-core/task-02-state-machine.md)
- [Task 1 (fix round) — Org-structure test tolerates rows added by other suites](decisions/case-core/task-01-fix-org-structure-test.md)

## test-infrastructure

- [Added a shared resetDatabase() helper to fix cross-file test-isolation leaks](decisions/test-infrastructure/global-reset-helper.md)
- [Fixed a flaky timeout in the auth refresh concurrent-replay test](decisions/test-infrastructure/refresh-concurrent-replay-timeout.md)
