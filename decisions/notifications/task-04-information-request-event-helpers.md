# Task 4 — Information-request notification event helpers

**Date:** 2026-10-06

**What:**
Added three event helper functions to `src/modules/notifications/notifications.events.ts`:
- `notifyInformationRequestRaised(source, caseRow, request)` — sends separate notifications to the responder and the requester when a request is raised; skips inactive recipients and deduplicates if requester is also responder
- `notifyInformationRequestAnswered(source, caseRow, request)` — sends a notification to the assigned legal rep only when a request is answered; silently skips if no rep is assigned
- `notifyInformationRequestReopened(source, caseRow, request)` — sends a notification to the responder when a request is reopened

Each function calls `createNotifications` with:
- The event type (`info_request.raised`, `info_request.answered`, or `info_request.reopened`)
- The case ID
- A list of Draft notifications with userId, title, and body

Sensitive fields (subject line, response text, reopen comment) are excluded from notification bodies per test specifications.

**Why:**
These helpers complete Phase 2, sub-project 4 (notifications) by wiring information-request events to the notification system. They follow the same pattern as existing case-lifecycle helpers (`notifyCaseRegistered`, `notifyCaseAssigned`, etc.), ensuring consistency in the event-driven architecture.

The implementation uses the existing `createNotifications` function which handles:
- Deduplication (first-match-wins)
- Active-user filtering (skips inactive recipients automatically)
- Transaction safety via the DataSource/EntityManager abstraction
