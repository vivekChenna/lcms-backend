# Task 5 — Wire case actions to notifications

**Date:** 2026-10-06

**What:**
`submitCase` now calls `notifyCaseRegistered` after its audit event. `assignCase`, `acceptAssignment` and `rejectAssignment` call `notifyCaseAssigned`, `notifyCaseAccepted` and `notifyAssignmentRejected` after their audit events, and `closeCase` calls `notifyCaseClosed` with its transaction `manager`. Added `test/integration/modules/notifications/case-events.test.ts` (10 tests).

**Why:**
The event helpers from Task 3 did nothing until the actions called them. `closeCase` passes `manager` so the notification commits or rolls back with the close (a blocked close leaves no notification). Auto-routing in `submitCase` goes through `assignCase`, so assigned notifications come from there without extra code. Signatures, status codes, auth and audit behavior are unchanged.
