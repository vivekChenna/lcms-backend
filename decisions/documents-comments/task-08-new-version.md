# Task 8 — Upload a new version

**Date:** 2026-10-06

**What:** Added `POST /documents/:id/versions?category=`, built on the shared `performUpload` pipeline. The new row links to the previous head (`previousVersionId`), shares its `rootDocumentId`, and inherits the category unless one is passed. Old bytes are never touched.

**Why:** Everything is re-read and re-checked inside `authorize`, which runs once unlocked and again under the case lock: write eligibility, the target is not an information-request attachment (409), and the target is still the head of its chain (409). So two concurrent uploads cannot both supersede the same version. The new number is MAX(version) over every row in the chain, deleted ones included, plus one, so a version number is never reused. If the target lookup 404s before the pipeline starts, the multipart stream is drained so the request does not hang. Any eligible writer may add a version, not only the original uploader.
