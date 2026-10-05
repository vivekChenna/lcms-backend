# Task 7 — Document list, version history, streamed download

**Date:** 2026-10-06

**What:** Added `GET /cases/:id/documents` (head of each version chain, newest first; `includeHistory=true` for all non-deleted versions; optional `informationRequestId` filter), `GET /documents/:id/versions` (whole non-deleted chain ascending) and `GET /documents/:id/download` (`disposition=attachment|inline`). Added `findLiveDocument` (404 if missing or deleted), reused by later tasks, and `contentDispositionHeader`.

**Why:** Download streams bytes through the API after an entitlement check (`getCaseById`), so access control is always enforced and there are no presigned URLs to leak. A deleted document or one on an invisible case is a 404, never a 403. The header helper emits a sanitised ASCII `filename` fallback plus an RFC 5987 `filename*`, so quotes, backslashes and CR/LF in a filename cannot escape the header. `X-Content-Type-Options: nosniff` stops browsers reinterpreting the stored type.
