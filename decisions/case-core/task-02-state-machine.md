# Task 2 — Case status state machine

**Date:** 2026-10-04

**What:** Created `src/modules/cases/state-machine.ts` with `canTransition()` and `assertTransition()` functions that encode legal case status transitions: Submitted→Assigned, Assigned→{In Progress, Submitted, Assigned}, In Progress→{Waiting on Input, Closed, Assigned}, Waiting on Input→{In Progress, Assigned}, and Closed (terminal, no outgoing transitions). Also allows reassignment from any open status back to Assigned for manager override.

**Why:** The state machine is foundational shared logic used by every workflow function from Task 7 onward. Defined here as standalone, verified, testable logic independent of database concerns, following TDD with 10 passing tests. Includes Waiting on Input edges (spec §3/§8) even though no caller exists yet in this sub-project, so sub-project 2 (information requests) inherits a verified, complete table instead of re-deriving it.
