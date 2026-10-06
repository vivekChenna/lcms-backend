# Task 6 — Wire information-request actions to notifications

**Date:** 2026-10-06

**What:**
`raiseInformationRequest`, `respondToInformationRequest` and `reopenInformationRequest` now call `notifyInformationRequestRaised`, `notifyInformationRequestAnswered` and `notifyInformationRequestReopened` after their audit events, using the transaction `manager` and the locked case row. Added `test/integration/modules/notifications/information-request-events.test.ts` (6 tests).

**Why:**
The Task 4 helpers did nothing until the actions called them. Running inside the existing transaction means a failed raise, answer or reopen leaves no notification, and the locked case row gives the helpers a consistent view of the assigned rep and requester. Signatures, status codes, auth and audit behavior are unchanged.
