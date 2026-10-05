# Task 9 — Information-request attachments

**Date:** 2026-10-06

**What:** Added `POST /information-requests/:id/attachments?category=`, built on the shared `performUpload` pipeline. The file is stored as version 1 of a new document linked to the request (`informationRequestId`) and audited as `document.uploaded`.

**Why:** Only the request's `responderId` may attach, whatever their role (including `viewer` and `legal_rep`), and only while the request is `open`; the general case write-eligibility rule, which bars viewers, deliberately does not apply. The request is re-read through the transaction manager inside `authorize`, so the check holds under the case lock. A non-responder gets 403 and a non-open request gets 409. If the request lookup 404s before the pipeline starts, the multipart stream is drained so the request does not hang. A requester in another department still passes the case visibility gate through the information-request responder link.
