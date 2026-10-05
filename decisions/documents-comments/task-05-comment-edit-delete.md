# Task 5 — Comment edit and delete

**Date:** 2026-10-06

**What:** Added `PATCH /comments/:id` (200) and `DELETE /comments/:id` (204) to the comments module. Delete is a soft delete: `deletedAt` is set and the row is kept.

**Why:** Only the author may change a comment, even an admin or manager cannot (VC-17). Both operations share one helper that reads the comment once to learn the case, checks case visibility and internal-note visibility (404, so a note's existence is not leaked), then re-reads the comment under the case row lock. Check order inside the transaction is viewer (403), Closed (409), not the author (403), so a Closed case reports 409 even to a non-author. Audit entries record the old and new body on edit and the deletion time on delete, with the case reference number.
