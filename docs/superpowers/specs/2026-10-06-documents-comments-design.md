# Documents & Comments — Design Spec

Status: Draft for review
Date: 2026-10-06
Parent spec: `docs/superpowers/specs/2026-09-27-lcms-backend-design.md` (§4.5, §7, §8)
Source requirements: `20260823_Legal Case Management System - requirement vdraft2.0 (1).pdf` (BRD v1.0)

## 1. Purpose & scope

Third sub-project of Phase 2 (case workflow), building on case core (sub-project 1)
and information requests (sub-project 2). Implements the case document repository
(upload, new versions, preview/download, soft delete) and the case Communications
tab (requester-visible comments and internal legal notes). It also closes two items
earlier specs deferred here: attachments on information-request responses (VC-10,
PR-05) and optional documents at closure (WF-11).

Out of scope (deferred): notification dispatch on document/comment events
(sub-project 4); content sniffing or antivirus scanning of uploads; auditing of
downloads/previews (AU-12 lists create/update/status events, not reads); retention
or purge policies; bulk (zip) download; pagination of the document and comment lists
(per-case volumes are small; lists return arrays like the information-request list).

## 2. Decisions taken in brainstorming

Where the BRD is silent, these were decided explicitly with the product owner. Items
marked **(extension)** go beyond the literal BRD text.

| Question | Decision |
|---|---|
| Who uploads documents to a case | legal roles per AC-05/AC-06, **and requesters on any case they can see (extension)**; viewers never |
| Who posts comments | legal roles, **and requesters on any case they can see (extension)**; viewers never (PR-33) |
| Internal notes | created/edited/deleted by legal roles only (AC-10); **read by legal roles only** — requesters and viewers never see them |
| File type / size limits (VC-15) | PDF, doc/docx, xls/xlsx, png, jpg/jpeg, txt; 25 MB; both configurable via env |
| Document categories (VC-15, DM-08) | fixed list in code: Evidence, Correspondence, Legal Opinion, Contract, Closure Document, Other |
| Versioning (DM-08) | upload-new-version flow; old versions retained and downloadable, never overwritten |
| Edit/delete of comments and notes | author only, soft delete, audited (VC-17 read as "own is allowed") |
| Delete of documents | **uploader may soft-delete their own (extension)**; the BRD never mentions document deletion |
| Closed cases | read-only: no new or changed documents/comments (**assumption** — see §5) |

## 3. Storage

- New shared unit `src/shared/storage/`: an `ObjectStorage` interface
  (`put(key, stream, mimeType)`, `get(key)` returning a readable stream, `delete(key)`)
  and an `S3ObjectStorage` implementation on `@aws-sdk/client-s3` +
  `@aws-sdk/lib-storage` (MinIO in dev via `forcePathStyle`, S3-compatible in prod;
  SE-03 satisfied by pointing the endpoint at Algihaz-hosted storage). `buildApp`
  accepts an `ObjectStorage` so tests inject an in-memory fake; no S3 container is
  required to run the suite.
- Uploads use `@fastify/multipart` and stream straight to storage — never to local
  disk (parent spec §7). The multipart `fileSize` limit is enforced while streaming;
  an exceeded limit aborts the upload, deletes any partial object, and returns 413.
- Object key: `cases/{caseId}/{documentId}` (UUIDs only; the user-supplied filename
  never appears in a key). Buckets are private; there are no presigned URLs, so all
  access control stays in code (AC-11).
- New env vars (validated at boot by the existing Zod schema): `S3_ENDPOINT`,
  `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_FORCE_PATH_STYLE`, `UPLOAD_MAX_BYTES` (default 26214400),
  `UPLOAD_ALLOWED_EXTENSIONS` (default `pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt`).
- Type validation (VC-15): the filename extension must be on the allowlist **and** the
  declared mime type must match that extension's expected type(s); otherwise 400
  before any bytes are stored. Content sniffing is deferred (§1).

## 4. Data model

### `documents`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| caseId | uuid FK → cases, NOT NULL | every document belongs to a case |
| informationRequestId | uuid FK → information_requests, nullable | set for information-request attachments |
| filename | varchar | sanitized (no path separators), original extension kept |
| mimeType | varchar | |
| sizeBytes | bigint | |
| category | varchar | one of the fixed list in §2 |
| version | integer | 1 for a first upload |
| rootDocumentId | uuid FK → documents | id of version 1 (itself for version 1) |
| previousVersionId | uuid FK → documents, nullable | null for version 1 |
| uploaderId | uuid FK → users | |
| createdAt | timestamptz | VC-15 timestamp |
| deletedAt | timestamptz, nullable | soft delete |

The parent spec's `information_request_attachments` join table is **not** built:
each attachment belongs to exactly one request, so a direct nullable FK is simpler and
equivalent. This is a deliberate deviation from parent spec §4.4.

The **head** of a version chain is the highest `version` among non-deleted rows with
the same `rootDocumentId`. Default listings show heads only.

### `comments`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| caseId | uuid FK → cases | |
| authorId | uuid FK → users | |
| body | text | non-empty |
| isInternal | boolean, default false | legal-only note vs requester-visible comment |
| createdAt / updatedAt | timestamptz | |
| deletedAt | timestamptz, nullable | soft delete |

One migration, `1700000012000-create-documents-and-comments.ts`; both entities are
registered in `src/db/entities.ts`.

## 5. Authorization and state rules

**Visibility gate (all reads and writes).** Every endpoint first reuses case core's
`getCaseById` as the visibility gate: a case the caller cannot see yields 404. This
gives legal roles and viewers read access to everything, requesters their department's
cases plus cases where they are an information-request responder (AC-04), with one
rule defined in one place. For endpoints addressed by a document, comment or request
id, the parent case is loaded first and the same gate applied.

**Write eligibility (upload, new version, comment).** After the gate:
1. `viewer` → 403.
2. Case `Closed` → 409 (checked before ownership, per the check-ordering lesson from
   case core: a status guard must precede an ownership guard that a wrong-state case
   could also fail).
3. `legal_rep` → must be the case's `assignedLegalRepId` and the case must be
   `In Progress` or `Waiting on Input` (assigned *and accepted*, AC-05); otherwise 403.
   `legal_manager`/`admin` → allowed (AC-06). `requester` → allowed (extension).

**Documents**
- Upload to a case: `POST /cases/:id/documents?category=<category>`, multipart body
  with a single `file` part. `category` is a **query parameter**, not a multipart
  field: the upload streams, so a field placed after the file part could not be read
  before the stream starts, and a query parameter lets it be validated up front.
  A zero-byte file is rejected with 400.
- New version: `POST /documents/:id/versions?category=<category>` (multipart `file`;
  `category` optional, inherited from the superseded version if omitted). The target must be the current head of its chain and a
  case-level document (versioning information-request attachments is not required and
  is rejected with 409). Eligibility is the write-eligibility rule above.
- Information-request attachment: `POST /information-requests/:id/attachments?category=<category>`
  (multipart `file`). Only
  the request's `responderId` (AC-15), and only while the request is `open` (403/409
  respectively). Attachments are optional on a response (VC-10: "allow one or more").
  A reopened round is a new open request, so the responder can attach again.
- Closure documents (WF-11): the close endpoint is unchanged. The lawyer uploads
  closure documents beforehand with category "Closure Document".
- List: `GET /cases/:id/documents` returns heads, optionally filtered by
  `?informationRequestId=`; `?includeHistory=true` returns all non-deleted versions.
  `GET /documents/:id/versions` returns the whole non-deleted chain for one document.
- Download/preview: `GET /documents/:id/download` (`?disposition=inline` for in-browser
  preview, UI-14; default `attachment`). It applies the visibility gate, then streams
  from storage with the stored mime type, an RFC 5987 `Content-Disposition`, and
  `X-Content-Type-Options: nosniff`. Deleted documents return 404.
- Delete: `DELETE /documents/:id` — uploader only (403 otherwise), soft delete. Not
  allowed on a `Closed` case (409). An information-request attachment can only be
  deleted while its request is still `open` (409 after it is answered, so the response
  record stays stable). Deleting a head makes the previous non-deleted version the head.

**Comments**
- Post: `POST /cases/:id/comments` `{ body, isInternal? }`. Write eligibility applies.
  `isInternal: true` additionally requires a legal role (`legal_rep`/`legal_manager`/
  `admin`); a requester sending it gets 403.
- List: `GET /cases/:id/comments`, ordered oldest first, deleted rows excluded.
  Requesters and viewers never receive `isInternal` rows; legal roles receive all.
- Edit: `PATCH /comments/:id` `{ body }`; delete: `DELETE /comments/:id`. Author only
  (VC-17) — no other user, including admins, may edit or delete someone else's. For
  an internal note the author must still hold a legal role (AC-10). Both return 409 on
  a `Closed` case.
- A comment or note the caller is not entitled to see is reported as 404, not 403, so
  its existence is not leaked.

**Assumption to confirm (§2).** The product owner said "Closed is read-only for new
content". This spec extends that to *editing and deleting* existing documents and
comments on a Closed case (409), so a closed case file stays stable. Reverse this if
authors should still be able to correct their own entries after closure.

## 6. Upload flow

1. Authorize (§5) and validate the declared filename/mime/category — all before
   reading the file stream.
2. Stream the file to storage under a freshly generated document id; enforce the size
   limit while streaming (413 + cleanup on overflow).
3. In one transaction, with a row lock on the case (the same pattern information
   requests and `closeCase` use), re-check that the case is not `Closed`, insert the
   `documents` row, and write the audit entry. The re-check under lock closes the race
   with a concurrent close.
4. If step 3 fails, delete the stored object (best effort). A failed delete leaves an
   unreferenced object, which is harmless to correctness and noted as a known
   limitation.

Comment mutations follow step 3's transaction/lock pattern without the storage steps.

## 7. Audit logging

`document.uploaded`, `document.version_uploaded`, `document.deleted`,
`comment.created` (covers both comments and internal notes; `isInternal` is in the
values), `comment.edited`, `comment.deleted`. Every entry carries the case id and the
case's `referenceNumber`; document entries include `documentId`, `filename`, `category`
and `version`; edits record the old and new body. Matches the case-core convention
(AU-12).

## 8. Error handling

400 invalid type/category/body; 403 role or ownership; 404 not visible or deleted;
409 Closed case, non-head version, request not open, or deleting a locked attachment;
413 over size limit. The 413 needs an error class mapped in `src/shared/errors.ts` /
the central error handler (added if absent).

## 9. Test infrastructure changes

- `test/integration/helpers/reset-db.ts` gains `comments` and `documents` ahead of
  `information_requests` in `RESET_TABLES_IN_ORDER` (documents reference cases, users
  and information requests; the list must stay FK-safe).
- A multipart upload helper for tests, and an in-memory `ObjectStorage` fake wired into
  `buildTestApp`.

## 10. Testing

- Per endpoint: happy path, role rejection (viewer; requester posting an internal
  note; legal_rep not assigned or not yet accepted), ownership rejection (non-author
  edit/delete, non-uploader delete, non-responder attachment), wrong-state rejection
  (Closed, answered request, non-head version).
- VC-15: disallowed extension, mismatched mime, oversize (413, nothing left stored),
  unknown category.
- Visibility: a requester outside the department sees documents/comments only through
  an information-request responder link; internal notes never reach requesters or
  viewers (list and by-id).
- Versioning: chain numbering, head listing, history listing, delete-of-head promotes
  the previous version, old versions still downloadable.
- Download: correct bytes round-trip through the fake storage, inline vs attachment
  headers, 404 for deleted and for invisible cases.
- Race: a concurrent close and upload on the same case never both succeed and never
  leave a Closed case with a new document inserted after closure.
- Review Focus (inputs that would bite a real user): filenames with path separators,
  unicode or very long names; zero-byte files; a requester who is *only* a responder
  uploading to a case outside their department; deleting the latest version of a
  two-version chain.

## 11. Requirement traceability (spot-check)

DM-08 (§4, §5 versions/category); VC-15 (§3, §5, §10); AC-10, AC-11 (§5); VC-17 (§5);
VC-10, PR-05, PR-12 (§5 attachments, download); PR-13, WF-11 (§5); UI-10, UI-14, UI-17
(§5 list/preview/internal); AU-12 (§7); SE-03 (§3); PR-33 (§5 viewer). Notifications
for these events remain deferred to sub-project 4.
