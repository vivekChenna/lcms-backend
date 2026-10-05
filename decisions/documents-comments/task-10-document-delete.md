# Task 10 — Document soft delete

**Date:** 2026-10-06

**What:** Added `DELETE /documents/:id` (204). It sets `deletedAt` on the document and writes a `document.deleted` audit event. The stored object is retained.

**Why:** Only the uploader may delete, including for information-request attachments, so an admin or legal manager gets 403. The case is locked and the document re-read inside the transaction; the order of checks is Closed (409), uploader-only (403), then attachment lock (409 once the request is no longer `open`). The visibility gate runs first, so an invisible case or an already-deleted document is 404. Soft delete keeps the bytes and the version row, so deleting the latest version promotes the previous one to head in the list, and a later new version is numbered after the highest existing version rather than reusing a number.
