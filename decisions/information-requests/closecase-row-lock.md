# Closed the parked finding: closeCase now locks the case row

**Date:** 2026-10-04

**What:** `closeCase` (`src/modules/cases/cases.workflow.service.ts`) is now wrapped in `dataSource.transaction(...)` and takes a `pessimistic_write` lock on the case row before its VC-12 open-information-request check, via a new local `lockCaseOrThrow` helper — the same pattern `information-requests.service.ts` already uses for raise/respond/reopen. Added a concurrency regression test in `close.test.ts`: fires a close and a raise at the same case simultaneously and asserts exactly one succeeds, with the final DB state always consistent (never a Closed case with an open information request).

**Why:** The final whole-branch review's fix wave added row-locking to raise/respond/reopen to fix a real concurrency bug, but `closeCase` itself was left unlocked — flagged by both the fix implementer and the re-reviewer as a parked, out-of-scope gap: a concurrent `closeCase` and `raise`/`respond`/`reopen` could each read "no open requests" / "case not yet Closed" before the other committed, letting both proceed. The user asked to close this gap in the same session, rather than leave it for a later sub-project.

**Verification:** `close.test.ts` (7 tests, including the new concurrency test) run 6 times total (1 full pass + 5 repeats of just the new test) — consistent results every time, both race outcomes (close wins / raise wins) observed and handled cleanly. `tsc --noEmit` clean.
