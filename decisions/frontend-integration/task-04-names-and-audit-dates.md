# Task 4 — Names on comments, requests, documents, notifications and audit rows; audit date filter

**Date:** 2026-10-09

**What:** Comment responses gain `authorName` and `authorRole`; information request responses gain `raisedByName`, `raisedByRole` and `responderName`; document responses gain `uploadedByName`; notification responses gain `relatedCaseReference`; audit rows gain `actorName`, `actorRole` and `caseReference`. All are `string | null`. `GET /audit` and `GET /audit/export` accept `createdFrom` and `createdTo` (inclusive, 400 when `createdFrom` is after `createdTo` or a date does not parse), and the audit CSV gains `actorName`, `actorRole` and `caseReference` columns after the existing ones. `serializeAuditRows` lives in `audit.serialize.ts` so Task 8 can reuse it.

**Why:** The frontend shows names and case references instead of ids, and the audit screen needs a date window. Each response loads its names with one batched lookup (`loadUserNames`, `loadCaseReferences`) for the whole result, and ids that do not resolve give null. The audit filters moved to a QueryBuilder so the date range can be applied; `auditFilterShape`, `dateOrder` and `dateOrderMessage` are exported for reuse because `.refine` wraps the schema and cannot be extended afterwards.
