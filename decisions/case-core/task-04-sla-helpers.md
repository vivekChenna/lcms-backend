# Task 4 — SLA due-date computation and live state derivation

**Date:** 2026-10-04

**What:** Created `src/modules/cases/sla.ts` with `computeDueDates()` (calculates ack and resolution due dates from submission time and SLA hours), `deriveSlaState()` (derives 'on_track' | 'at_risk' | 'breached' | 'met' from case status and time), `deriveCaseAgeHours()` (elapsed hours since creation, frozen at closure), and `toCaseWithSla()` (attaches slaState and caseAgeHours to a case object). At-risk state uses a percentage-of-window rule (20%, constant `SLA_AT_RISK_WINDOW_FRACTION`) so different case types' SLAs scale dynamically rather than a fixed hour threshold applying uniformly across very different durations.

**Why:** Provides SLA-derived fields consumed by `seedCase` (Task 1), `submitCase` (Task 9), and returned by `cases.service.ts` and `cases.workflow.service.ts` (Tasks 7–12) in every case response. Defined as standalone, testable logic independent of database concerns, following TDD with 9 passing tests. The percentage-based at-risk window was decided in the brainstorming session (2026-10-01): the BRD requires an "at-risk" state to exist but specifies no numeric rule, and a percentage scales correctly across case types with very different SLA lengths (e.g. a 4-hour ack window and a 72-hour resolution window) instead of one fixed hour count being meaningful for both.
