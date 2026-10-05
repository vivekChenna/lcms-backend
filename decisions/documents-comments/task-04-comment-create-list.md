# Task 4 — Case write-eligibility helper, comment create and list

**Date:** 2026-10-06

**What:** Added `src/modules/cases/case-access.ts` (`isLegalRole`, `assertCaseNotClosed`, `assertCaseWriteEligibility`), exported `lockCaseOrThrow` from the case workflow service, and added the comments module with `POST /cases/:id/comments` and `GET /cases/:id/comments`.

**Why:** Documents and comments share one "who may write to a case" rule, so it lives in a pure helper. Check order is visibility (404), viewer (403), Closed (409), then a legal_rep must be the assigned rep who accepted the case (403); this follows case core's lesson that a Closed case must report 409 even to a non-owner. Create locks the case row so a concurrent closure cannot slip a comment in. Internal notes are legal-role-only for both writing and reading; requesters and viewers see only non-internal, non-deleted comments, oldest first.
