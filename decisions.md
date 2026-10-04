# Decisions log

One entry per meaningful change, newest first. Each entry: what changed, and why — so the reasoning behind a change survives independently of digging through commit messages or chat history.

---

## 2026-10-04 — Case status state machine

**What:** Created `src/modules/cases/state-machine.ts` with `canTransition()` and `assertTransition()` functions that encode legal case status transitions: Submitted→Assigned, Assigned→{In Progress, Submitted, Assigned}, In Progress→{Waiting on Input, Closed, Assigned}, Waiting on Input→{In Progress, Assigned}, and Closed (terminal, no outgoing transitions). Also allows reassignment from any open status back to Assigned for manager override.

**Why:** Task 2 of case-core module — the state machine is foundational shared logic used by every workflow function from Task 7 onward. Defined here as standalone, verified, testable logic independent of database concerns, following TDD with 10 passing tests. Includes Waiting on Input edges (spec §3/§8) even though no caller exists yet in this sub-project, so sub-project 2 inherits a verified, complete table instead of re-deriving it.

---

## 2026-10-04 — Org-structure test tolerates rows added by other suites

**What:** Changed org-structure test "seeds the 10 required entities (DM-03)" from asserting exact entity count to checking that 10 known seeded codes are present as a subset of results.

**Why:** The exact-count assertion (`toHaveLength(10)`) was fragile: other test suites (e.g., case-core fixtures) insert rows into the shared `entities` table without cleanup. The test doesn't own the table and shouldn't enforce its total size; it should only verify the migration seeded the 10 known codes. Changed to `arrayContaining` to tolerate extra rows from other suites.

---

## 2026-10-04 — Started this log

**What:** Created `decisions.md`, committed to git, to be updated alongside every meaningful change from here on.

**Why:** Explicit standing instruction — every future change should carry a recorded reason, not just a commit message, so the "why" behind a decision is easy to find later without reconstructing it from conversation history.
