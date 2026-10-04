# Task 3 — Case-transition helpers (markCaseWaitingOnInput / markCaseInProgress)

**Date:** 2026-10-04

**What:** Added two case-status transition functions to `src/modules/cases/cases.workflow.service.ts`: `markCaseWaitingOnInput()` and `markCaseInProgress()`. The former moves a case from "In Progress" to "Waiting on Input" (with a no-op guard if already in that state), while the latter moves a case from "Waiting on Input" back to "In Progress". Both validate transitions via the existing `assertTransition()` state machine and log audit events. Created integration tests in `test/integration/modules/cases/information-request-transitions.test.ts` validating the state transitions, audit logging, no-op behavior, and rejection of invalid transitions (using existing case-core seeding helpers).

**Why:** Tasks 4–6 (raise, respond, reopen information requests) need to coordinate case status alongside request state. These helpers encapsulate the case-status mutations and audit logging, keeping the information-request workflow code clean and ensuring consistent use of the state machine and audit trail. The no-op guard in `markCaseWaitingOnInput()` prevents spurious audit entries when a case is already waiting on input. Integration tests verify the helpers behave correctly with real database fixtures before being consumed by higher-level service code.
