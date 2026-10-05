# Task 6 — Case document upload

**Date:** 2026-10-06

**What:** Added `POST /cases/:id/documents?category=` (201) with the documents schemas, service and routes. The service's `performUpload` is the shared pipeline (also reused by later version and information-request uploads): visibility and write-eligibility pre-check, file validation, streaming to object storage through a size limiter, then one transaction that locks the case row, re-checks eligibility, inserts the `documents` row and writes the audit entry. Any failure after the bytes were stored deletes the stored object.

**Why:** Streaming straight to storage avoids buffering files in memory. The authoritative eligibility check runs under the case row lock so an upload cannot commit after a concurrent close (the race test holds the lock in another transaction, closes the case, and expects 409 with the object cleaned up). The storage key is `cases/{caseId}/{documentId}`, never derived from the filename. No multipart or filename-decoding changes were needed: `@fastify/multipart` 10.1.2 with `defCharset: 'utf8'` round-trips non-ASCII filenames, and an oversize file surfaces as 413 from the size limiter.
