# Documents & Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the case document repository (streamed upload, new versions, preview/download, soft delete, information-request attachments) and the case Communications tab (requester-visible comments and internal legal notes).

**Architecture:** Two new feature modules, `src/modules/documents/` and `src/modules/comments/`, following the same entity/schemas/service/routes layout as `src/modules/information-requests/`. File bytes go through a small `ObjectStorage` interface (`src/shared/storage/`) with an S3/MinIO implementation for production and an in-memory fake for tests. Every write first reuses case core's `getCaseById` as the visibility gate, then a shared `assertCaseWriteEligibility` rule, and mutates inside a transaction holding a `pessimistic_write` lock on the case row (the same pattern information requests and `closeCase` use).

**Tech Stack:** Fastify 5, TypeORM, PostgreSQL, Zod 4 + fastify-type-provider-zod, `@fastify/multipart`, `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-documents-comments-design.md` (parent: `docs/superpowers/specs/2026-09-27-lcms-backend-design.md`)

## Global Constraints

- Schema changes only via committed migrations — never `synchronize: true`.
- **Commit messages must NOT contain a `Co-Authored-By` trailer or any Claude/Anthropic attribution line.** The project owner has asked for this repeatedly. Write commit messages as plain text, as shown in each task's commit step.
- All authorization is enforced server-side in the service layer. Every endpoint first calls `getCaseById(dataSource, actor, caseId)` (from `src/modules/cases/cases.service.ts`) as the visibility gate: a case the caller cannot see yields 404.
- Write eligibility for case-level uploads, new versions and comments, applied after the gate and in this order: `viewer` → 403; case `Closed` → 409; `legal_rep` must be the case's `assignedLegalRepId` and the case must be `In Progress` or `Waiting on Input`, else 403; `legal_manager`, `admin` and `requester` are allowed.
- Closed cases are read-only: no new documents, versions or comments, and no edit/delete of existing ones (409).
- Max upload size default: `26214400` bytes (25 MB), env `UPLOAD_MAX_BYTES`. Allowed extensions default: `pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt`, env `UPLOAD_ALLOWED_EXTENSIONS`. The declared mime type must match the extension.
- Document categories (fixed list in code): `Evidence`, `Correspondence`, `Legal Opinion`, `Contract`, `Closure Document`, `Other`.
- Storage object key: `cases/{caseId}/{documentId}` (UUIDs only, never the filename). No presigned URLs; downloads always stream through the API after an entitlement check.
- Every mutating function writes a `logAuditEvent` entry inside its transaction; entries carry `caseId` and the case's `referenceNumber` in `afterValue`.
- Internal notes are readable by legal roles (`legal_rep`, `legal_manager`, `admin`) only. A note/comment the caller may not see is reported as 404, never 403.
- Every route returning a `Date` through a Zod `z.string()` schema must convert at the route boundary (`.toISOString()`); `fastify-type-provider-zod` does not coerce `Date`.
- TDD: write the failing test before the implementation, for every task.
- Test files must use `resetDatabase(ds)` from `test/integration/helpers/reset-db.ts` in their per-test reset, and must seed any fixture users per test (never once in `beforeAll`, because `resetDatabase` deletes `users`).

## Review Focus

- A filename with path separators (`../../etc/evil.pdf`), non-ASCII characters, or more than 255 characters must be stored safely (sanitized, extension kept) and never influence the storage key. Pinned in Task 6.
- A zero-byte upload must be rejected with 400 and leave nothing in storage. Pinned in Task 6.
- A requester who can see a case only because they are an information-request responder (other department) must be able to upload and comment, but not read internal notes. Pinned in Tasks 4 and 6.
- Deleting the latest version of a two-version chain must make the previous version the head, and a later new version must continue numbering without reusing a number. Pinned in Task 10.
- A whitespace-only comment body must be rejected, and an internal note must never reach a requester or viewer through the list or by id. Pinned in Tasks 4 and 5.

---

### Task 1: Dependencies, env config, upload rules, 413 error

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add`)
- Modify: `src/config/env.ts`
- Modify: `src/shared/errors.ts`
- Create: `src/modules/documents/upload-config.ts`
- Modify: `.env.example` (only if the file exists)
- Test: `test/unit/config/env-storage.test.ts`
- Test: `test/unit/shared/payload-too-large.test.ts`
- Test: `test/unit/modules/documents/upload-config.test.ts`

**Interfaces:**
- Produces: `DOCUMENT_CATEGORIES`, `type DocumentCategory`, `EXTENSION_MIME_TYPES`, `type UploadConfig = { maxBytes: number; allowedExtensions: string[] }`, `DEFAULT_UPLOAD_CONFIG`, `parseUploadConfig(maxBytes: number, allowedCsv: string): UploadConfig`, `normalizeMimeType(mime: string): string`, `sanitizeFilename(raw: string): string`, `validateUploadFile(config, rawFilename, mimeType): { filename: string; extension: string }` (throws `ValidationError`), `PayloadTooLargeError` (413, code `PAYLOAD_TOO_LARGE`), and `Env` gaining `S3_ENDPOINT?`, `S3_REGION`, `S3_BUCKET?`, `S3_ACCESS_KEY_ID?`, `S3_SECRET_ACCESS_KEY?`, `S3_FORCE_PATH_STYLE: boolean`, `UPLOAD_MAX_BYTES: number`, `UPLOAD_ALLOWED_EXTENSIONS: string`.

- [ ] **Step 1: Install the new packages**

Run: `pnpm add @fastify/multipart @aws-sdk/client-s3 @aws-sdk/lib-storage`
Expected: the three packages appear under `dependencies` in `package.json`. Then run `pnpm ls @fastify/multipart @aws-sdk/client-s3 @aws-sdk/lib-storage` and confirm all three resolve (`@fastify/multipart` must be the major version that supports Fastify 5, currently 9.x — pnpm picks it automatically).

- [ ] **Step 2: Write the failing tests**

```typescript
// test/unit/shared/payload-too-large.test.ts
import { describe, it, expect } from 'vitest';
import { PayloadTooLargeError, AppError } from '../../../src/shared/errors';

describe('PayloadTooLargeError', () => {
  it('is an AppError mapped to 413', () => {
    const err = new PayloadTooLargeError('too big');
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(413);
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
```

```typescript
// test/unit/config/env-storage.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('storage and upload env settings', () => {
  it('defaults the upload settings and leaves S3 settings optional', () => {
    const env = loadEnv({ ...base });
    expect(env.UPLOAD_MAX_BYTES).toBe(26214400);
    expect(env.UPLOAD_ALLOWED_EXTENSIONS).toBe('pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it('parses explicit S3 and upload settings', () => {
    const env = loadEnv({
      ...base,
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'me-south-1',
      S3_BUCKET: 'lcms-documents',
      S3_ACCESS_KEY_ID: 'lcms',
      S3_SECRET_ACCESS_KEY: 'lcms12345',
      S3_FORCE_PATH_STYLE: 'false',
      UPLOAD_MAX_BYTES: '1048576',
      UPLOAD_ALLOWED_EXTENSIONS: 'pdf,png',
    });
    expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
    expect(env.S3_BUCKET).toBe('lcms-documents');
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.UPLOAD_MAX_BYTES).toBe(1048576);
    expect(env.UPLOAD_ALLOWED_EXTENSIONS).toBe('pdf,png');
  });
});
```

```typescript
// test/unit/modules/documents/upload-config.test.ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_UPLOAD_CONFIG,
  DOCUMENT_CATEGORIES,
  normalizeMimeType,
  parseUploadConfig,
  sanitizeFilename,
  validateUploadFile,
} from '../../../../src/modules/documents/upload-config';
import { ValidationError } from '../../../../src/shared/errors';

describe('upload config', () => {
  it('has the fixed category list and the default limits', () => {
    expect(DOCUMENT_CATEGORIES).toEqual(['Evidence', 'Correspondence', 'Legal Opinion', 'Contract', 'Closure Document', 'Other']);
    expect(DEFAULT_UPLOAD_CONFIG.maxBytes).toBe(26214400);
    expect(DEFAULT_UPLOAD_CONFIG.allowedExtensions).toEqual(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'txt']);
  });

  it('parses a csv allowlist, lowercasing and trimming', () => {
    expect(parseUploadConfig(100, ' PDF , png ')).toEqual({ maxBytes: 100, allowedExtensions: ['pdf', 'png'] });
  });

  it('refuses an unsupported extension in the allowlist at boot', () => {
    expect(() => parseUploadConfig(100, 'pdf,exe')).toThrow(/unsupported extension.*exe/);
  });

  it('refuses an empty allowlist', () => {
    expect(() => parseUploadConfig(100, ' , ')).toThrow(/at least one extension/);
  });
});

describe('normalizeMimeType', () => {
  it('drops parameters and lowercases', () => {
    expect(normalizeMimeType('Text/Plain; charset=utf-8')).toBe('text/plain');
  });
});

describe('sanitizeFilename', () => {
  it('strips directory components, both separators', () => {
    expect(sanitizeFilename('../../etc/evil.pdf')).toBe('evil.pdf');
    expect(sanitizeFilename('..\\..\\windows\\evil.pdf')).toBe('evil.pdf');
  });

  it('strips control characters and trims', () => {
    expect(sanitizeFilename('  a\u0000b\u001f.pdf ')).toBe('ab.pdf');
  });

  it('keeps non-ASCII names intact', () => {
    expect(sanitizeFilename('عقد-2026.pdf')).toBe('عقد-2026.pdf');
  });

  it('truncates an over-long name to 255 characters while keeping the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(400)}.pdf`);
    expect(out.length).toBe(255);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});

describe('validateUploadFile', () => {
  it('accepts an allowed extension with a matching mime type', () => {
    expect(validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'Contract.PDF', 'application/pdf')).toEqual({ filename: 'Contract.PDF', extension: 'pdf' });
  });

  it('accepts docx and xlsx with their official mime types', () => {
    expect(validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').extension).toBe('docx');
    expect(validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').extension).toBe('xlsx');
  });

  it('rejects an extension that is not on the allowlist', () => {
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'virus.exe', 'application/octet-stream')).toThrow(ValidationError);
  });

  it('rejects a mime type that does not match the extension', () => {
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'a.pdf', 'image/png')).toThrow(/does not match/);
  });

  it('rejects a name with no extension and a name that sanitizes to empty', () => {
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'README', 'text/plain')).toThrow(ValidationError);
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, '../', 'text/plain')).toThrow(/filename is required/);
  });

  it('honours a narrowed allowlist', () => {
    const config = parseUploadConfig(100, 'pdf');
    expect(() => validateUploadFile(config, 'a.png', 'image/png')).toThrow(ValidationError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/shared/payload-too-large.test.ts test/unit/config/env-storage.test.ts test/unit/modules/documents/upload-config.test.ts`
Expected: FAIL — `PayloadTooLargeError` not exported, env fields undefined, module `upload-config` not found.

- [ ] **Step 4: Implement**

```typescript
// src/shared/errors.ts — append at the end of the file
export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = 'PAYLOAD_TOO_LARGE';
}
```

```typescript
// src/config/env.ts — add these keys inside envSchema (after REFRESH_TOKEN_EXPIRES_DAYS)
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),
  UPLOAD_ALLOWED_EXTENSIONS: z.string().min(1).default('pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt'),
```

```typescript
// src/modules/documents/upload-config.ts
import path from 'node:path';
import { ValidationError } from '../../shared/errors';

export const DOCUMENT_CATEGORIES = [
  'Evidence',
  'Correspondence',
  'Legal Opinion',
  'Contract',
  'Closure Document',
  'Other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const EXTENSION_MIME_TYPES: Record<string, readonly string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  txt: ['text/plain'],
};

export type UploadConfig = { maxBytes: number; allowedExtensions: string[] };

export const DEFAULT_UPLOAD_CONFIG: UploadConfig = {
  maxBytes: 26_214_400,
  allowedExtensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'txt'],
};

export function parseUploadConfig(maxBytes: number, allowedCsv: string): UploadConfig {
  const allowedExtensions = allowedCsv
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowedExtensions.length === 0) {
    throw new Error('UPLOAD_ALLOWED_EXTENSIONS must list at least one extension');
  }
  const unknown = allowedExtensions.filter((extension) => !(extension in EXTENSION_MIME_TYPES));
  if (unknown.length > 0) {
    throw new Error(`UPLOAD_ALLOWED_EXTENSIONS contains unsupported extension(s): ${unknown.join(', ')}`);
  }
  return { maxBytes, allowedExtensions };
}

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length > 255) {
    const extension = path.extname(cleaned);
    cleaned = cleaned.slice(0, 255 - extension.length) + extension;
  }
  return cleaned;
}

export function validateUploadFile(
  config: UploadConfig,
  rawFilename: string,
  mimeType: string,
): { filename: string; extension: string } {
  const filename = sanitizeFilename(rawFilename);
  if (!filename) {
    throw new ValidationError('A filename is required');
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!extension || !config.allowedExtensions.includes(extension)) {
    throw new ValidationError(`File type '${extension ? `.${extension}` : 'without an extension'}' is not allowed`);
  }
  const expected = EXTENSION_MIME_TYPES[extension];
  if (!expected.includes(normalizeMimeType(mimeType))) {
    throw new ValidationError(`Declared type '${mimeType}' does not match '.${extension}'`);
  }
  return { filename, extension };
}
```

If `.env.example` exists, append:

```
# Document storage (S3-compatible; MinIO in dev — see docker-compose.dev.yml)
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=lcms-documents
S3_ACCESS_KEY_ID=lcms
S3_SECRET_ACCESS_KEY=lcms12345
S3_FORCE_PATH_STYLE=true
UPLOAD_MAX_BYTES=26214400
UPLOAD_ALLOWED_EXTENSIONS=pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/shared/payload-too-large.test.ts test/unit/config/env-storage.test.ts test/unit/modules/documents/upload-config.test.ts && npx tsc --noEmit`
Expected: PASS (all tests), `tsc` clean.

- [ ] **Step 6: Commit**

Create `decisions/documents-comments/task-01-config-and-upload-rules.md` (format of `decisions/information-requests/task-01-entity-migration-fixtures.md`: `# Task N — <title>`, `**Date:**`, `**What:**`, `**Why:**`), then add a new `## documents-comments (Phase 2, sub-project 3)` section to `decisions.md` directly above the `## information-requests` section, containing one bullet linking to it. Stage everything and commit in one commit:

```bash
git add package.json pnpm-lock.yaml src/config/env.ts src/shared/errors.ts src/modules/documents/upload-config.ts test/unit/config/env-storage.test.ts test/unit/shared/payload-too-large.test.ts test/unit/modules/documents/upload-config.test.ts decisions.md decisions/documents-comments/task-01-config-and-upload-rules.md
git add .env.example 2>/dev/null; true
git commit -m "feat: upload env config, file validation rules, 413 error"
```

---

### Task 2: Storage layer, app wiring, test helpers

**Files:**
- Create: `src/shared/storage/object-storage.ts`
- Create: `src/shared/storage/s3-object-storage.ts`
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Create: `test/integration/helpers/in-memory-storage.ts`
- Create: `test/integration/helpers/multipart.ts`
- Create: `test/integration/helpers/auth-header.ts`
- Modify: `test/integration/helpers/build-test-app.ts`
- Test: `test/unit/helpers/in-memory-storage.test.ts`
- Test: `test/unit/helpers/multipart.test.ts`
- Test: `test/integration/storage/s3-object-storage.smoke.test.ts`

**Interfaces:**
- Consumes: `UploadConfig`, `DEFAULT_UPLOAD_CONFIG` (Task 1), `Env`.
- Produces: `interface ObjectStorage { put(key: string, body: Readable, mimeType: string): Promise<void>; get(key: string): Promise<Readable>; delete(key: string): Promise<void> }`; `S3ObjectStorage` (`ensureBucket()`), `createS3StorageFromEnv(env: Env): S3ObjectStorage`; `type AppOptions = { storage: ObjectStorage; uploadConfig?: UploadConfig }`; `buildApp(dataSource, options: AppOptions)`; test helpers `InMemoryObjectStorage` (`objects: Map<string, { body: Buffer; mimeType: string }>`, `seed(key, body: Buffer, mimeType)`), `buildMultipartBody(parts)`, `authHeader(app, userId, role)`, `buildTestApp(dataSource, options?: { storage?: ObjectStorage; uploadConfig?: Partial<UploadConfig> })`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/helpers/in-memory-storage.test.ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { InMemoryObjectStorage } from '../../integration/helpers/in-memory-storage';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('InMemoryObjectStorage', () => {
  it('round-trips bytes and the mime type', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put('a/b', Readable.from([Buffer.from('hel'), Buffer.from('lo')]), 'text/plain');
    expect((await readAll(await storage.get('a/b'))).toString()).toBe('hello');
    expect(storage.objects.get('a/b')?.mimeType).toBe('text/plain');
  });

  it('stores nothing when the source stream errors midway', async () => {
    const storage = new InMemoryObjectStorage();
    async function* broken() {
      yield Buffer.from('partial');
      throw new Error('boom');
    }
    await expect(storage.put('k', Readable.from(broken()), 'text/plain')).rejects.toThrow('boom');
    expect(storage.objects.size).toBe(0);
  });

  it('rejects get for a missing key and tolerates deleting one', async () => {
    const storage = new InMemoryObjectStorage();
    await expect(storage.get('nope')).rejects.toThrow(/No such object/);
    await expect(storage.delete('nope')).resolves.toBeUndefined();
  });

  it('seed() places an object directly and delete() removes it', async () => {
    const storage = new InMemoryObjectStorage();
    storage.seed('k', Buffer.from('x'), 'text/plain');
    expect(storage.objects.size).toBe(1);
    await storage.delete('k');
    expect(storage.objects.size).toBe(0);
  });
});
```

```typescript
// test/unit/helpers/multipart.test.ts
import { describe, it, expect } from 'vitest';
import { buildMultipartBody } from '../../integration/helpers/multipart';

describe('buildMultipartBody', () => {
  it('builds a body whose boundary matches the content-type header', () => {
    const { payload, headers } = buildMultipartBody([
      { name: 'file', filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('PDFDATA') },
    ]);
    const boundary = /boundary=(.+)$/.exec(headers['content-type'])?.[1];
    expect(boundary).toBeTruthy();
    const text = payload.toString('utf8');
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="a.pdf"');
    expect(text).toContain('Content-Type: application/pdf');
    expect(text).toContain('PDFDATA');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});
```

```typescript
// test/integration/storage/s3-object-storage.smoke.test.ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { S3ObjectStorage } from '../../../src/shared/storage/s3-object-storage';

// Opt-in: runs only against a real S3-compatible endpoint (e.g. the dev MinIO).
//   S3_SMOKE_TEST=1 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY_ID=lcms \
//   S3_SECRET_ACCESS_KEY=lcms12345 npx vitest run test/integration/storage
const enabled = process.env.S3_SMOKE_TEST === '1';

describe.skipIf(!enabled)('S3ObjectStorage against a real S3-compatible endpoint', () => {
  it('round-trips and deletes an object', async () => {
    const storage = new S3ObjectStorage({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET ?? 'lcms-documents-smoke',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    });
    await storage.ensureBucket();
    const key = `smoke/${Date.now()}`;
    await storage.put(key, Readable.from([Buffer.from('hello')]), 'text/plain');
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await storage.delete(key);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/helpers test/integration/storage`
Expected: FAIL — `Cannot find module '../../integration/helpers/in-memory-storage'` (the smoke test is skipped but its import of `s3-object-storage` also fails to resolve).

- [ ] **Step 3: Implement the storage layer**

```typescript
// src/shared/storage/object-storage.ts
import type { Readable } from 'node:stream';

export interface ObjectStorage {
  put(key: string, body: Readable, mimeType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
```

```typescript
// src/shared/storage/s3-object-storage.ts
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Env } from '../../config/env';
import type { ObjectStorage } from './object-storage';

export type S3StorageConfig = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) {
        throw error;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Readable, mimeType: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType },
    });
    await upload.done();
  }

  async get(key: string): Promise<Readable> {
    const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return output.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createS3StorageFromEnv(env: Env): S3ObjectStorage {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set to enable document storage');
  }
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}
```

- [ ] **Step 4: Implement the test helpers**

```typescript
// test/integration/helpers/in-memory-storage.ts
import { Readable } from 'node:stream';
import type { ObjectStorage } from '../../../src/shared/storage/object-storage';

export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; mimeType: string }>();

  async put(key: string, body: Readable, mimeType: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
    }
    this.objects.set(key, { body: Buffer.concat(chunks), mimeType });
  }

  async get(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`No such object: ${key}`);
    }
    return Readable.from([object.body]);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  seed(key: string, body: Buffer, mimeType: string): void {
    this.objects.set(key, { body, mimeType });
  }
}
```

```typescript
// test/integration/helpers/multipart.ts
import crypto from 'node:crypto';

export type MultipartPart = { name: string; filename: string; contentType: string; content: Buffer | string };

export function buildMultipartBody(parts: MultipartPart[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----lcmstest${crypto.randomUUID().replace(/-/g, '')}`;
  const buffers: Buffer[] = [];
  for (const part of parts) {
    buffers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
        'utf8',
      ),
      Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(buffers), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
```

```typescript
// test/integration/helpers/auth-header.ts
import type { FastifyInstance } from 'fastify';

export function authHeader(app: FastifyInstance, userId: string, role: string): { authorization: string } {
  const token = app.signAccessToken({ id: userId, role, departmentId: null, entityId: null, businessUnitId: null });
  return { authorization: `Bearer ${token}` };
}
```

```typescript
// test/integration/helpers/build-test-app.ts  (replace the whole file)
import type { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { buildApp } from '../../../src/app';
import type { ObjectStorage } from '../../../src/shared/storage/object-storage';
import { DEFAULT_UPLOAD_CONFIG, type UploadConfig } from '../../../src/modules/documents/upload-config';
import { InMemoryObjectStorage } from './in-memory-storage';

export function buildTestApp(
  dataSource: DataSource,
  options: { storage?: ObjectStorage; uploadConfig?: Partial<UploadConfig> } = {},
): FastifyInstance {
  return buildApp(dataSource, {
    storage: options.storage ?? new InMemoryObjectStorage(),
    uploadConfig: { ...DEFAULT_UPLOAD_CONFIG, ...options.uploadConfig },
  });
}
```

- [ ] **Step 5: Wire the app**

```typescript
// src/app.ts — add imports
import multipart from '@fastify/multipart';
import type { ObjectStorage } from './shared/storage/object-storage';
import { DEFAULT_UPLOAD_CONFIG, type UploadConfig } from './modules/documents/upload-config';

// replace the buildApp signature and add the multipart registration right after registerErrorHandler(app)
export type AppOptions = { storage: ObjectStorage; uploadConfig?: UploadConfig };

export function buildApp(dataSource: DataSource, options: AppOptions): FastifyInstance {
  const uploadConfig = options.uploadConfig ?? DEFAULT_UPLOAD_CONFIG;
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  app.decorate('dataSource', dataSource);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  // fileSize is one byte above the configured max so the service's own
  // SizeLimiter (which counts bytes and returns the project's 413 error) trips
  // first; this is only the backstop that stops a runaway upload.
  app.register(multipart, {
    limits: { fileSize: uploadConfig.maxBytes + 1, files: 1 },
    defParamCharset: 'utf8',
  });
  // ... the rest of the function body is unchanged (swagger, rate limit, auth, routes, /health)
```

```typescript
// src/server.ts — replace the body of main() up to app.listen
import { createS3StorageFromEnv } from './shared/storage/s3-object-storage';
import { parseUploadConfig } from './modules/documents/upload-config';

async function main(): Promise<void> {
  const env = loadEnv();
  const storage = createS3StorageFromEnv(env);
  await storage.ensureBucket();
  const uploadConfig = parseUploadConfig(env.UPLOAD_MAX_BYTES, env.UPLOAD_ALLOWED_EXTENSIONS);
  await AppDataSource.initialize();
  const app = buildApp(AppDataSource, { storage, uploadConfig });
  // ... shutdown handlers and app.listen unchanged
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run test/unit/helpers test/integration/storage && npx tsc --noEmit`
Expected: PASS (helper unit tests pass; the smoke test reports as skipped), `tsc` clean. Then run `npx vitest run test/integration/modules/audit` to prove existing suites still boot through `buildTestApp` — expected PASS.

- [ ] **Step 7: Commit**

Create `decisions/documents-comments/task-02-storage-layer.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/shared/storage src/app.ts src/server.ts test/integration/helpers/in-memory-storage.ts test/integration/helpers/multipart.ts test/integration/helpers/auth-header.ts test/integration/helpers/build-test-app.ts test/unit/helpers test/integration/storage decisions.md decisions/documents-comments/task-02-storage-layer.md
git commit -m "feat: object storage interface, S3 implementation, multipart wiring, test helpers"
```

---

### Task 3: Entities, migration, reset helper, fixtures

**Files:**
- Create: `src/modules/documents/entities/case-document.entity.ts`
- Create: `src/modules/comments/entities/case-comment.entity.ts`
- Create: `src/db/migrations/1700000012000-create-documents-and-comments.ts`
- Modify: `src/db/migrations/index.ts`
- Modify: `src/db/entities.ts`
- Modify: `test/integration/helpers/reset-db.ts`
- Create: `test/integration/helpers/seed-document.ts`
- Create: `test/integration/helpers/seed-comment.ts`
- Create: `test/integration/helpers/seed-case-scenario.ts`
- Test: `test/integration/modules/documents/documents-comments-entities.test.ts`

**Interfaces:**
- Produces: `CaseDocument` entity (`id, caseId, informationRequestId, filename, mimeType, sizeBytes: number, category: DocumentCategory, version, rootDocumentId, previousVersionId, uploaderId, createdAt, deletedAt`), `CaseComment` entity (`id, caseId, authorId, body, isInternal, createdAt, updatedAt, deletedAt`); `seedDocument(ds, overrides: { caseId: string; uploaderId: string; id?; informationRequestId?; filename?; mimeType?; sizeBytes?; category?; version?; rootDocumentId?; previousVersionId?; deletedAt? }): Promise<CaseDocument>`; `seedComment(ds, overrides: { caseId: string; authorId: string; body?; isInternal?; deletedAt? }): Promise<CaseComment>`; `seedCaseWithParties(ds, overrides?: { status?: Case['status'] }): Promise<{ master; repId: string; requesterId: string; caseRow: Case }>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/documents/documents-comments-entities.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedDocument } from '../../helpers/seed-document';
import { seedComment } from '../../helpers/seed-comment';
import { CaseDocument } from '../../../../src/modules/documents/entities/case-document.entity';

describe('documents and comments entities + migration', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('round-trips a first-version document, defaulting root to itself', async () => {
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    expect(doc.id).toBeTruthy();
    expect(doc.version).toBe(1);
    expect(doc.rootDocumentId).toBe(doc.id);
    expect(doc.previousVersionId).toBeNull();
    expect(doc.informationRequestId).toBeNull();
    expect(doc.deletedAt).toBeNull();
    expect(typeof doc.sizeBytes).toBe('number');
  });

  it('links a second version to the first and reads sizeBytes back as a number', async () => {
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, sizeBytes: 5_000_000_000 });

    const v2 = await seedDocument(ds, {
      caseId: caseRow.id,
      uploaderId: repId,
      version: 2,
      rootDocumentId: v1.id,
      previousVersionId: v1.id,
    });

    expect(v2.rootDocumentId).toBe(v1.id);
    expect(v2.previousVersionId).toBe(v1.id);
    const reloaded = await ds.getRepository(CaseDocument).findOneByOrFail({ id: v1.id });
    expect(reloaded.sizeBytes).toBe(5_000_000_000);
  });

  it('round-trips a comment with an internal flag', async () => {
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'Privileged note', isInternal: true });

    expect(comment.isInternal).toBe(true);
    expect(comment.deletedAt).toBeNull();
    expect(comment.createdAt).toBeInstanceOf(Date);
  });

  it('seedCaseWithParties maps status to an accepted/unaccepted assignment', async () => {
    const accepted = await seedCaseWithParties(ds, { status: 'In Progress' });
    expect(accepted.caseRow.assignedLegalRepId).toBe(accepted.repId);
    expect(accepted.caseRow.assignmentAcceptedAt).toBeInstanceOf(Date);

    const submitted = await seedCaseWithParties(ds, { status: 'Submitted' });
    expect(submitted.caseRow.assignedLegalRepId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/documents/documents-comments-entities.test.ts`
Expected: FAIL — `Cannot find module '../../helpers/seed-case-scenario'`.

- [ ] **Step 3: Write the entities**

```typescript
// src/modules/documents/entities/case-document.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import type { DocumentCategory } from '../upload-config';

// pg returns bigint as a string; sizes are well inside Number's safe range.
const bigintToNumber = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

@Entity('documents')
export class CaseDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  caseId!: string;

  @Column({ type: 'uuid', nullable: true })
  informationRequestId!: string | null;

  @Column({ type: 'varchar' })
  filename!: string;

  @Column({ type: 'varchar' })
  mimeType!: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  sizeBytes!: number;

  @Column({ type: 'varchar' })
  category!: DocumentCategory;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'uuid' })
  rootDocumentId!: string;

  @Column({ type: 'uuid', nullable: true })
  previousVersionId!: string | null;

  @Column({ type: 'uuid' })
  uploaderId!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
```

```typescript
// src/modules/comments/entities/case-comment.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('comments')
export class CaseComment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  caseId!: string;

  @Column({ type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'boolean', default: false })
  isInternal!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
```

- [ ] **Step 4: Write and register the migration**

```typescript
// src/db/migrations/1700000012000-create-documents-and-comments.ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateDocumentsAndComments1700000012000 implements MigrationInterface {
  name = 'CreateDocumentsAndComments1700000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'documents',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid' },
          { name: 'informationRequestId', type: 'uuid', isNullable: true },
          { name: 'filename', type: 'varchar' },
          { name: 'mimeType', type: 'varchar' },
          { name: 'sizeBytes', type: 'bigint' },
          { name: 'category', type: 'varchar' },
          { name: 'version', type: 'integer' },
          { name: 'rootDocumentId', type: 'uuid' },
          { name: 'previousVersionId', type: 'uuid', isNullable: true },
          { name: 'uploaderId', type: 'uuid' },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'deletedAt', type: 'timestamptz', isNullable: true },
        ],
      }),
    );
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['caseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['informationRequestId'], referencedTableName: 'information_requests', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['rootDocumentId'], referencedTableName: 'documents', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['previousVersionId'], referencedTableName: 'documents', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['uploaderId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createIndex('documents', new TableIndex({ name: 'IDX_documents_caseId', columnNames: ['caseId'] }));
    await queryRunner.createIndex('documents', new TableIndex({ name: 'IDX_documents_rootDocumentId', columnNames: ['rootDocumentId'] }));

    await queryRunner.createTable(
      new Table({
        name: 'comments',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid' },
          { name: 'authorId', type: 'uuid' },
          { name: 'body', type: 'text' },
          { name: 'isInternal', type: 'boolean', default: false },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
          { name: 'deletedAt', type: 'timestamptz', isNullable: true },
        ],
      }),
    );
    await queryRunner.createForeignKey('comments', new TableForeignKey({ columnNames: ['caseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('comments', new TableForeignKey({ columnNames: ['authorId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createIndex('comments', new TableIndex({ name: 'IDX_comments_caseId', columnNames: ['caseId'] }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('comments');
    await queryRunner.dropTable('documents');
  }
}
```

```typescript
// src/db/migrations/index.ts — add import and array entry
import { CreateDocumentsAndComments1700000012000 } from './1700000012000-create-documents-and-comments';
// ...append to the migrations array after CreateInformationRequests1700000011000:
  CreateDocumentsAndComments1700000012000,
```

```typescript
// src/db/entities.ts — add imports and array entries
import { CaseDocument } from '../modules/documents/entities/case-document.entity';
import { CaseComment } from '../modules/comments/entities/case-comment.entity';
// ...append to the entities array after InformationRequest:
  CaseDocument,
  CaseComment,
```

- [ ] **Step 5: Extend the reset helper (critical)**

`documents` and `comments` reference `cases` and `users` with RESTRICT, and `documents` also references `information_requests`. Without this change every other test file's `resetDatabase` fails with FK violations once any document exists.

```typescript
// test/integration/helpers/reset-db.ts — replace RESET_TABLES_IN_ORDER
const RESET_TABLES_IN_ORDER = [
  'audit_log',
  'comments',
  'documents',
  'information_requests',
  'refresh_tokens',
  'user_roles',
  'routing_rules',
  'cases',
  'users',
];
```

- [ ] **Step 6: Write the fixtures**

```typescript
// test/integration/helpers/seed-document.ts
import crypto from 'node:crypto';
import type { DataSource } from 'typeorm';
import { CaseDocument } from '../../../src/modules/documents/entities/case-document.entity';
import type { DocumentCategory } from '../../../src/modules/documents/upload-config';

export async function seedDocument(
  ds: DataSource,
  overrides: {
    caseId: string;
    uploaderId: string;
    id?: string;
    informationRequestId?: string | null;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
    category?: DocumentCategory;
    version?: number;
    rootDocumentId?: string;
    previousVersionId?: string | null;
    deletedAt?: Date | null;
  },
): Promise<CaseDocument> {
  const id = overrides.id ?? crypto.randomUUID();
  const repo = ds.getRepository(CaseDocument);
  return repo.save(
    repo.create({
      id,
      caseId: overrides.caseId,
      informationRequestId: overrides.informationRequestId ?? null,
      filename: overrides.filename ?? 'contract.pdf',
      mimeType: overrides.mimeType ?? 'application/pdf',
      sizeBytes: overrides.sizeBytes ?? 1024,
      category: overrides.category ?? 'Evidence',
      version: overrides.version ?? 1,
      rootDocumentId: overrides.rootDocumentId ?? id,
      previousVersionId: overrides.previousVersionId ?? null,
      uploaderId: overrides.uploaderId,
      deletedAt: overrides.deletedAt ?? null,
    }),
  );
}
```

```typescript
// test/integration/helpers/seed-comment.ts
import type { DataSource } from 'typeorm';
import { CaseComment } from '../../../src/modules/comments/entities/case-comment.entity';

export async function seedComment(
  ds: DataSource,
  overrides: { caseId: string; authorId: string; body?: string; isInternal?: boolean; deletedAt?: Date | null },
): Promise<CaseComment> {
  const repo = ds.getRepository(CaseComment);
  return repo.save(
    repo.create({
      caseId: overrides.caseId,
      authorId: overrides.authorId,
      body: overrides.body ?? 'A comment',
      isInternal: overrides.isInternal ?? false,
      deletedAt: overrides.deletedAt ?? null,
    }),
  );
}
```

```typescript
// test/integration/helpers/seed-case-scenario.ts
import type { DataSource } from 'typeorm';
import type { Case } from '../../../src/modules/cases/entities/case.entity';
import { seedCase, seedCaseMasterData } from './seed-case';
import { seedUserWithRole } from './seed-user';

// A case with a legal_rep and a same-department requester. "In Progress",
// "Waiting on Input" and "Closed" cases are assigned to and accepted by the rep;
// "Assigned" is assigned but not accepted; "Submitted" is unassigned.
export async function seedCaseWithParties(
  ds: DataSource,
  overrides: { status?: Case['status'] } = {},
): Promise<{
  master: Awaited<ReturnType<typeof seedCaseMasterData>>;
  repId: string;
  requesterId: string;
  caseRow: Case;
}> {
  const status = overrides.status ?? 'In Progress';
  const master = await seedCaseMasterData(ds);
  const repId = await seedUserWithRole(ds, 'legal_rep');
  const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
  const accepted = status === 'In Progress' || status === 'Waiting on Input' || status === 'Closed';
  const caseRow = await seedCase(ds, {
    ...master,
    requesterId,
    status,
    assignedLegalRepId: status === 'Submitted' ? null : repId,
    assignmentAcceptedAt: accepted ? new Date() : null,
  });
  return { master, repId, requesterId, caseRow };
}
```

- [ ] **Step 7: Run the test and typecheck**

Run: `npx vitest run test/integration/modules/documents/documents-comments-entities.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), `tsc` clean. Then run the whole case + information-request suites to prove the reset-helper change broke nothing: `npx vitest run test/integration/modules/cases test/integration/modules/information-requests` — expected PASS.

- [ ] **Step 8: Commit**

Create `decisions/documents-comments/task-03-entities-migration-fixtures.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/documents/entities src/modules/comments/entities src/db/migrations/1700000012000-create-documents-and-comments.ts src/db/migrations/index.ts src/db/entities.ts test/integration/helpers/reset-db.ts test/integration/helpers/seed-document.ts test/integration/helpers/seed-comment.ts test/integration/helpers/seed-case-scenario.ts test/integration/modules/documents/documents-comments-entities.test.ts decisions.md decisions/documents-comments/task-03-entities-migration-fixtures.md
git commit -m "feat: documents and comments tables, entities, reset helper and fixtures"
```

---

### Task 4: Case write-eligibility helper, comment create and list

**Files:**
- Create: `src/modules/cases/case-access.ts`
- Modify: `src/modules/cases/cases.workflow.service.ts` (export `lockCaseOrThrow`)
- Create: `src/modules/comments/comments.schemas.ts`
- Create: `src/modules/comments/comments.service.ts`
- Create: `src/modules/comments/comments.routes.ts`
- Modify: `src/app.ts`
- Test: `test/unit/modules/cases/case-access.test.ts`
- Test: `test/integration/modules/comments/create-and-list.test.ts`

**Interfaces:**
- Consumes: `CaseComment`, `seedComment`, `seedCaseWithParties`, `authHeader`, `buildTestApp`, `Actor` + `getCaseById` from `../cases/cases.service`, `logAuditEvent`.
- Produces: `isLegalRole(role: string): boolean`; `assertCaseNotClosed(caseRow: { status: string }): void` (409); `assertCaseWriteEligibility(actor: Actor, caseRow: { status: string; assignedLegalRepId: string | null }): void` (rules in Global Constraints); `lockCaseOrThrow(manager: EntityManager, caseId: string): Promise<Case>` now exported from `cases.workflow.service.ts`; `createComment(dataSource, actor, caseId, input: { body: string; isInternal: boolean }): Promise<CaseComment>`; `listComments(dataSource, actor, caseId): Promise<CaseComment[]>`; `serializeComment(row: CaseComment)`; routes `POST /cases/:id/comments`, `GET /cases/:id/comments`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/modules/cases/case-access.test.ts
import { describe, it, expect } from 'vitest';
import { assertCaseNotClosed, assertCaseWriteEligibility, isLegalRole } from '../../../../src/modules/cases/case-access';
import { ConflictError, ForbiddenError } from '../../../../src/shared/errors';

const actor = (role: string, id = 'u1') => ({ id, role, departmentId: null, entityId: null, businessUnitId: null });
const caseRow = (status: string, assignedLegalRepId: string | null = 'u1') => ({ status, assignedLegalRepId });

describe('isLegalRole', () => {
  it('is true for legal_rep, legal_manager and admin only', () => {
    expect(isLegalRole('legal_rep')).toBe(true);
    expect(isLegalRole('legal_manager')).toBe(true);
    expect(isLegalRole('admin')).toBe(true);
    expect(isLegalRole('requester')).toBe(false);
    expect(isLegalRole('viewer')).toBe(false);
  });
});

describe('assertCaseNotClosed', () => {
  it('throws ConflictError only for a Closed case', () => {
    expect(() => assertCaseNotClosed({ status: 'Closed' })).toThrow(ConflictError);
    expect(() => assertCaseNotClosed({ status: 'In Progress' })).not.toThrow();
  });
});

describe('assertCaseWriteEligibility', () => {
  it('rejects a viewer with 403, even on a Closed case (role before state)', () => {
    expect(() => assertCaseWriteEligibility(actor('viewer'), caseRow('In Progress'))).toThrow(ForbiddenError);
    expect(() => assertCaseWriteEligibility(actor('viewer'), caseRow('Closed'))).toThrow(ForbiddenError);
  });

  it('rejects any writer on a Closed case with 409, before the ownership check', () => {
    expect(() => assertCaseWriteEligibility(actor('admin'), caseRow('Closed'))).toThrow(ConflictError);
    expect(() => assertCaseWriteEligibility(actor('legal_rep', 'other'), caseRow('Closed'))).toThrow(ConflictError);
  });

  it('lets the assigned legal_rep write while In Progress or Waiting on Input', () => {
    expect(() => assertCaseWriteEligibility(actor('legal_rep'), caseRow('In Progress'))).not.toThrow();
    expect(() => assertCaseWriteEligibility(actor('legal_rep'), caseRow('Waiting on Input'))).not.toThrow();
  });

  it('rejects a legal_rep who is assigned but has not accepted (status Assigned)', () => {
    expect(() => assertCaseWriteEligibility(actor('legal_rep'), caseRow('Assigned'))).toThrow(ForbiddenError);
  });

  it('rejects a legal_rep who is not the assigned rep', () => {
    expect(() => assertCaseWriteEligibility(actor('legal_rep', 'other'), caseRow('In Progress'))).toThrow(ForbiddenError);
  });

  it('lets legal_manager, admin and requester write to an open case in any status', () => {
    for (const role of ['legal_manager', 'admin', 'requester']) {
      for (const status of ['Submitted', 'Assigned', 'In Progress', 'Waiting on Input']) {
        expect(() => assertCaseWriteEligibility(actor(role), caseRow(status, null))).not.toThrow();
      }
    }
  });
});
```

```typescript
// test/integration/modules/comments/create-and-list.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedComment } from '../../helpers/seed-comment';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';

describe('POST/GET /cases/:id/comments', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  async function post(app: ReturnType<typeof buildTestApp>, caseId: string, userId: string, role: string, payload: unknown) {
    return app.inject({ method: 'POST', url: `/cases/${caseId}/comments`, headers: authHeader(app, userId, role), payload: payload as object });
  }

  it('lets the assigned, accepted legal_rep post a visible comment and audits it with the reference number', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, repId, 'legal_rep', { body: 'We have reviewed the contract.' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ caseId: caseRow.id, authorId: repId, body: 'We have reviewed the contract.', isInternal: false });
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'comment.created'`);
    expect(audit.afterValue.referenceNumber).toBe(caseRow.referenceNumber);
    await app.close();
  });

  it('lets a legal_rep post an internal note', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, repId, 'legal_rep', { body: 'Privileged strategy note', isInternal: true });

    expect(res.statusCode).toBe(201);
    expect(res.json().isInternal).toBe(true);
    await app.close();
  });

  it('lets a requester post a visible comment on a case in their own department', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, requesterId, 'requester', { body: 'Please prioritise this.' });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a requester posting an internal note with 403', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await post(app, caseRow.id, requesterId, 'requester', { body: 'sneaky', isInternal: true });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets a legal_manager comment on a case that is still Submitted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await post(app, caseRow.id, managerId, 'legal_manager', { body: 'Triage note', isInternal: true });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a viewer with 403', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const res = await post(app, caseRow.id, viewerId, 'viewer', { body: 'hello' });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a legal_rep who is not the assigned rep, and one who has not accepted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const notAccepted = await seedCaseWithParties(ds, { status: 'Assigned' });

    const other = await post(app, caseRow.id, otherRepId, 'legal_rep', { body: 'x' });
    const unaccepted = await post(app, notAccepted.caseRow.id, notAccepted.repId, 'legal_rep', { body: 'x' });

    expect(other.statusCode).toBe(403);
    expect(unaccepted.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a comment on a Closed case with 409', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });

    const res = await post(app, caseRow.id, repId, 'legal_rep', { body: 'too late' });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 404 for a requester outside the department who is not a responder', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await post(app, caseRow.id, outsiderId, 'requester', { body: 'hi' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('lets a requester who can see the case only as an information-request responder comment, but not read internal notes', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherMaster = await seedCaseMasterData(ds);
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'internal strategy', isInternal: true });

    const created = await post(app, caseRow.id, responderId, 'requester', { body: 'Answer incoming.' });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, responderId, 'requester') });

    expect(created.statusCode).toBe(201);
    expect(list.statusCode).toBe(200);
    expect(list.json().map((c: { body: string }) => c.body)).toEqual(['Answer incoming.']);
    await app.close();
  });

  it('rejects a whitespace-only or missing body with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const blank = await post(app, caseRow.id, repId, 'legal_rep', { body: '   \n  ' });
    const missing = await post(app, caseRow.id, repId, 'legal_rep', {});

    expect(blank.statusCode).toBe(400);
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it('lists oldest first, excludes deleted rows, and hides internal notes from requesters and viewers', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const viewerId = await seedUserWithRole(ds, 'viewer');
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'first visible' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'internal note', isInternal: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await seedComment(ds, { caseId: caseRow.id, authorId: requesterId, body: 'second visible' });
    await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'deleted', deletedAt: new Date() });

    const asRep = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, repId, 'legal_rep') });
    const asRequester = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, requesterId, 'requester') });
    const asViewer = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, viewerId, 'viewer') });

    expect(asRep.json().map((c: { body: string }) => c.body)).toEqual(['first visible', 'internal note', 'second visible']);
    expect(asRequester.json().map((c: { body: string }) => c.body)).toEqual(['first visible', 'second visible']);
    expect(asViewer.json().map((c: { body: string }) => c.body)).toEqual(['first visible', 'second visible']);
    await app.close();
  });

  it('returns 404 when listing comments on a case the caller cannot see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, outsiderId, 'requester') });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/modules/cases/case-access.test.ts test/integration/modules/comments/create-and-list.test.ts`
Expected: FAIL — `Cannot find module '.../case-access'` and 404 on `/cases/:id/comments`.

- [ ] **Step 3: Implement the access helper and export the lock helper**

```typescript
// src/modules/cases/case-access.ts
import { ConflictError, ForbiddenError } from '../../shared/errors';
import type { Actor } from './cases.service';

const LEGAL_ROLES = ['legal_rep', 'legal_manager', 'admin'];

export function isLegalRole(role: string): boolean {
  return LEGAL_ROLES.includes(role);
}

export function assertCaseNotClosed(caseRow: { status: string }): void {
  if (caseRow.status === 'Closed') {
    throw new ConflictError('Closed cases are read-only');
  }
}

// Write eligibility for documents and comments, applied AFTER the visibility
// gate (getCaseById) has already passed. Order matters: role before state
// (a viewer can never write), state before ownership (a Closed case must report
// 409 even to a legal_rep who is not its owner), per case core's check-ordering
// lesson in decisions/case-core/task-12-closure.md.
export function assertCaseWriteEligibility(
  actor: Actor,
  caseRow: { status: string; assignedLegalRepId: string | null },
): void {
  if (actor.role === 'viewer') {
    throw new ForbiddenError('Viewers cannot add or change documents or comments');
  }
  assertCaseNotClosed(caseRow);
  if (actor.role === 'legal_rep') {
    const acceptedByActor =
      caseRow.assignedLegalRepId === actor.id && (caseRow.status === 'In Progress' || caseRow.status === 'Waiting on Input');
    if (!acceptedByActor) {
      throw new ForbiddenError('Only the assigned legal representative who accepted the case can write to it');
    }
  }
}
```

In `src/modules/cases/cases.workflow.service.ts`, change the existing private helper declaration from `async function lockCaseOrThrow(` to `export async function lockCaseOrThrow(` (one-word change; leave the body and its comment untouched).

- [ ] **Step 4: Implement the comments module (create and list)**

```typescript
// src/modules/comments/comments.schemas.ts
import { z } from 'zod';

const bodySchema = z.string().trim().min(1).max(10000);

export const createCommentBodySchema = z.object({
  body: bodySchema,
  isInternal: z.boolean().default(false),
});

export const editCommentBodySchema = z.object({ body: bodySchema });

export const commentIdParamsSchema = z.object({ id: z.string().uuid() });

export const commentResponseSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  authorId: z.string(),
  body: z.string(),
  isInternal: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const commentListResponseSchema = z.array(commentResponseSchema);
```

```typescript
// src/modules/comments/comments.service.ts
import { IsNull, type DataSource } from 'typeorm';
import { CaseComment } from './entities/case-comment.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { lockCaseOrThrow } from '../cases/cases.workflow.service';
import { assertCaseWriteEligibility, isLegalRole } from '../cases/case-access';
import { ForbiddenError } from '../../shared/errors';
import { logAuditEvent } from '../audit/audit.service';

export async function createComment(
  dataSource: DataSource,
  actor: Actor,
  caseId: string,
  input: { body: string; isInternal: boolean },
): Promise<CaseComment> {
  await getCaseById(dataSource, actor, caseId);
  return dataSource.transaction(async (manager) => {
    const caseRow = await lockCaseOrThrow(manager, caseId);
    assertCaseWriteEligibility(actor, caseRow);
    if (input.isInternal && !isLegalRole(actor.role)) {
      throw new ForbiddenError('Only legal roles can create internal notes');
    }

    const repo = manager.getRepository(CaseComment);
    const comment = await repo.save(
      repo.create({ caseId, authorId: actor.id, body: input.body, isInternal: input.isInternal, deletedAt: null }),
    );
    await logAuditEvent(manager, {
      actorId: actor.id,
      caseId,
      action: 'comment.created',
      afterValue: { id: comment.id, caseId, referenceNumber: caseRow.referenceNumber, isInternal: comment.isInternal, body: comment.body },
    });
    return comment;
  });
}

export async function listComments(dataSource: DataSource, actor: Actor, caseId: string): Promise<CaseComment[]> {
  await getCaseById(dataSource, actor, caseId);
  const where = isLegalRole(actor.role)
    ? { caseId, deletedAt: IsNull() }
    : { caseId, deletedAt: IsNull(), isInternal: false };
  return dataSource.getRepository(CaseComment).find({ where, order: { createdAt: 'ASC' } });
}
```

```typescript
// src/modules/comments/comments.routes.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CaseComment } from './entities/case-comment.entity';
import { createComment, listComments } from './comments.service';
import { commentListResponseSchema, commentResponseSchema, createCommentBodySchema } from './comments.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';

export function serializeComment(row: CaseComment) {
  return {
    id: row.id,
    caseId: row.caseId,
    authorId: row.authorId,
    body: row.body,
    isInternal: row.isInternal,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function commentsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/cases/:id/comments', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      response: { 200: commentListResponseSchema },
    },
  }, async (request) => {
    const rows = await listComments(app.dataSource, request.user, request.params.id);
    return rows.map(serializeComment);
  });

  typedApp.post('/cases/:id/comments', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      body: createCommentBodySchema,
      response: { 201: commentResponseSchema },
    },
  }, async (request, reply) => {
    const comment = await createComment(app.dataSource, request.user, request.params.id, request.body);
    reply.status(201).send(serializeComment(comment));
  });
}
```

```typescript
// src/app.ts — add import and registration after app.register(informationRequestsRoutes);
import commentsRoutes from './modules/comments/comments.routes';
// ...
  app.register(commentsRoutes);
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/unit/modules/cases/case-access.test.ts test/integration/modules/comments/create-and-list.test.ts && npx tsc --noEmit`
Expected: PASS (8 unit + 12 integration tests), `tsc` clean.

- [ ] **Step 6: Commit**

Create `decisions/documents-comments/task-04-comment-create-list.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/cases/case-access.ts src/modules/cases/cases.workflow.service.ts src/modules/comments src/app.ts test/unit/modules/cases/case-access.test.ts test/integration/modules/comments/create-and-list.test.ts decisions.md decisions/documents-comments/task-04-comment-create-list.md
git commit -m "feat: case write-eligibility rule, POST/GET /cases/:id/comments"
```

---

### Task 5: Comment edit and delete

**Files:**
- Modify: `src/modules/comments/comments.service.ts`
- Modify: `src/modules/comments/comments.routes.ts`
- Test: `test/integration/modules/comments/edit-and-delete.test.ts`

**Interfaces:**
- Consumes: `assertCaseNotClosed`, `isLegalRole` (Task 4), `lockCaseOrThrow`, `editCommentBodySchema`, `commentIdParamsSchema`.
- Produces: `editComment(dataSource, actor, commentId, body: string): Promise<CaseComment>`, `deleteComment(dataSource, actor, commentId): Promise<void>`; routes `PATCH /comments/:id` (200), `DELETE /comments/:id` (204).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/comments/edit-and-delete.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedComment } from '../../helpers/seed-comment';
import { authHeader } from '../../helpers/auth-header';

describe('PATCH/DELETE /comments/:id', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('lets the author edit their own comment and audits old and new body', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: requesterId, body: 'Typo here' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/comments/${comment.id}`,
      headers: authHeader(app, requesterId, 'requester'),
      payload: { body: 'Fixed text' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('Fixed text');
    const [audit] = await ds.query(`SELECT "beforeValue", "afterValue" FROM audit_log WHERE action = 'comment.edited'`);
    expect(audit.beforeValue.body).toBe('Typo here');
    expect(audit.afterValue).toMatchObject({ body: 'Fixed text', referenceNumber: caseRow.referenceNumber });
    await app.close();
  });

  it('rejects editing or deleting someone else\'s comment, even by an admin or manager (VC-17)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: requesterId });
    const adminId = await seedUserWithRole(ds, 'admin');
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const adminEdit = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, adminId, 'admin'), payload: { body: 'x' } });
    const managerDelete = await app.inject({ method: 'DELETE', url: `/comments/${comment.id}`, headers: authHeader(app, managerId, 'legal_manager') });

    expect(adminEdit.statusCode).toBe(403);
    expect(managerDelete.statusCode).toBe(403);
    await app.close();
  });

  it('soft-deletes the author\'s own comment: 204, hidden from the list, row kept, audited', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId, body: 'to delete' });

    const res = await app.inject({ method: 'DELETE', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep') });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/comments`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(204);
    expect(list.json()).toEqual([]);
    const [row] = await ds.query(`SELECT "deletedAt" FROM comments WHERE id = $1`, [comment.id]);
    expect(row.deletedAt).not.toBeNull();
    const audits = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'comment.deleted'`);
    expect(audits).toHaveLength(1);
    expect(audits[0].afterValue.referenceNumber).toBe(caseRow.referenceNumber);
    await app.close();
  });

  it('returns 404 for a missing or already-deleted comment', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedComment(ds, { caseId: caseRow.id, authorId: repId, deletedAt: new Date() });

    const gone = await app.inject({ method: 'PATCH', url: `/comments/${deleted.id}`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: 'x' } });
    const missing = await app.inject({ method: 'DELETE', url: '/comments/6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e', headers: authHeader(app, repId, 'legal_rep') });

    expect(gone.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('reports an internal note as 404 (not 403) to a requester, so its existence is not leaked', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const note = await seedComment(ds, { caseId: caseRow.id, authorId: repId, isInternal: true });

    const edit = await app.inject({ method: 'PATCH', url: `/comments/${note.id}`, headers: authHeader(app, requesterId, 'requester'), payload: { body: 'x' } });
    const del = await app.inject({ method: 'DELETE', url: `/comments/${note.id}`, headers: authHeader(app, requesterId, 'requester') });

    expect(edit.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for a comment on a case the caller cannot see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, outsiderId, 'requester'), payload: { body: 'x' } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects edit and delete on a Closed case with 409, even for the author', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId });

    const edit = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: 'x' } });
    const del = await app.inject({ method: 'DELETE', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep') });

    expect(edit.statusCode).toBe(409);
    expect(del.statusCode).toBe(409);
    await app.close();
  });

  it('rejects an edit to a whitespace-only body with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const comment = await seedComment(ds, { caseId: caseRow.id, authorId: repId });

    const res = await app.inject({ method: 'PATCH', url: `/comments/${comment.id}`, headers: authHeader(app, repId, 'legal_rep'), payload: { body: '  ' } });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/comments/edit-and-delete.test.ts`
Expected: FAIL — `PATCH`/`DELETE /comments/:id` return 404 "Route not found".

- [ ] **Step 3: Implement**

```typescript
// src/modules/comments/comments.service.ts — merge these imports into the existing import lines
import type { EntityManager } from 'typeorm';
import { NotFoundError } from '../../shared/errors';           // add NotFoundError next to ForbiddenError
import { assertCaseNotClosed } from '../cases/case-access';     // add to the existing case-access import

// append at the end of the file
async function findLiveComment(source: DataSource | EntityManager, commentId: string): Promise<CaseComment> {
  const comment = await source.getRepository(CaseComment).findOne({ where: { id: commentId, deletedAt: IsNull() } });
  if (!comment) {
    throw new NotFoundError('Comment not found');
  }
  return comment;
}

// Shared by edit and delete. The first read learns the case id; everything that
// matters is re-read under the case lock. An internal note is invisible to
// non-legal roles (404, not 403); an author who has since lost their legal role
// therefore also sees 404 for their own old internal notes.
async function mutateOwnComment(
  dataSource: DataSource,
  actor: Actor,
  commentId: string,
  apply: (manager: EntityManager, comment: CaseComment, referenceNumber: string) => Promise<void>,
): Promise<void> {
  const preliminary = await findLiveComment(dataSource, commentId);
  await getCaseById(dataSource, actor, preliminary.caseId);
  if (preliminary.isInternal && !isLegalRole(actor.role)) {
    throw new NotFoundError('Comment not found');
  }
  await dataSource.transaction(async (manager) => {
    const caseRow = await lockCaseOrThrow(manager, preliminary.caseId);
    const comment = await findLiveComment(manager, commentId);
    if (actor.role === 'viewer') {
      throw new ForbiddenError('Viewers cannot change comments');
    }
    assertCaseNotClosed(caseRow);
    if (comment.authorId !== actor.id) {
      throw new ForbiddenError('Only the author can change this comment');
    }
    await apply(manager, comment, caseRow.referenceNumber);
  });
}

export async function editComment(dataSource: DataSource, actor: Actor, commentId: string, body: string): Promise<CaseComment> {
  let edited!: CaseComment;
  await mutateOwnComment(dataSource, actor, commentId, async (manager, comment, referenceNumber) => {
    const before = { id: comment.id, body: comment.body, isInternal: comment.isInternal };
    comment.body = body;
    edited = await manager.getRepository(CaseComment).save(comment);
    await logAuditEvent(manager, {
      actorId: actor.id,
      caseId: comment.caseId,
      action: 'comment.edited',
      beforeValue: before,
      afterValue: { id: comment.id, caseId: comment.caseId, referenceNumber, isInternal: comment.isInternal, body },
    });
  });
  return edited;
}

export async function deleteComment(dataSource: DataSource, actor: Actor, commentId: string): Promise<void> {
  await mutateOwnComment(dataSource, actor, commentId, async (manager, comment, referenceNumber) => {
    const before = { id: comment.id, body: comment.body, isInternal: comment.isInternal };
    comment.deletedAt = new Date();
    await manager.getRepository(CaseComment).save(comment);
    await logAuditEvent(manager, {
      actorId: actor.id,
      caseId: comment.caseId,
      action: 'comment.deleted',
      beforeValue: before,
      afterValue: { id: comment.id, caseId: comment.caseId, referenceNumber, isInternal: comment.isInternal, deletedAt: comment.deletedAt },
    });
  });
}
```

```typescript
// src/modules/comments/comments.routes.ts — update imports
import { createComment, deleteComment, editComment, listComments } from './comments.service';
import { commentIdParamsSchema, commentListResponseSchema, commentResponseSchema, createCommentBodySchema, editCommentBodySchema } from './comments.schemas';

// add inside commentsRoutes(), after the POST route
  typedApp.patch('/comments/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: commentIdParamsSchema,
      body: editCommentBodySchema,
      response: { 200: commentResponseSchema },
    },
  }, async (request) => {
    const comment = await editComment(app.dataSource, request.user, request.params.id, request.body.body);
    return serializeComment(comment);
  });

  typedApp.delete('/comments/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      security: [{ bearerAuth: [] }],
      params: commentIdParamsSchema,
    },
  }, async (request, reply) => {
    await deleteComment(app.dataSource, request.user, request.params.id);
    reply.status(204).send();
  });
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/comments && npx tsc --noEmit`
Expected: PASS (Task 4's 12 tests plus these 8), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/documents-comments/task-05-comment-edit-delete.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/comments test/integration/modules/comments/edit-and-delete.test.ts decisions.md decisions/documents-comments/task-05-comment-edit-delete.md
git commit -m "feat: author-only PATCH/DELETE /comments/:id with soft delete"
```

---

### Task 6: Case document upload

**Files:**
- Create: `src/modules/documents/documents.schemas.ts`
- Create: `src/modules/documents/documents.service.ts`
- Create: `src/modules/documents/documents.routes.ts`
- Modify: `src/app.ts`
- Test: `test/integration/modules/documents/upload.test.ts`

**Interfaces:**
- Consumes: `CaseDocument`, `ObjectStorage`, `UploadConfig`, `validateUploadFile`, `normalizeMimeType`, `DocumentCategory`, `assertCaseWriteEligibility`, `loadCaseOrThrow`/`lockCaseOrThrow`, `PayloadTooLargeError`, `InMemoryObjectStorage`, `buildMultipartBody`, `seedCaseWithParties`, `authHeader`.
- Produces: `type DocumentsDeps = { dataSource: DataSource; storage: ObjectStorage; uploadConfig: UploadConfig }`; `type IncomingFile = { filename: string; mimeType: string; stream: Readable }`; `documentStorageKey(caseId: string, documentId: string): string`; `uploadCaseDocument(deps, actor, caseId, category, file): Promise<CaseDocument>`; internal `performUpload(deps, actor, file, request: UploadRequest)` and `type UploadPlan = { version: number; rootDocumentId: string | null; previousVersionId: string | null }` reused by Tasks 8 and 9; `serializeDocument(row)`; schemas `documentCategorySchema`, `uploadQuerySchema`, `documentResponseSchema`; the plugin `documentsRoutes(app, { storage, uploadConfig })`; route `POST /cases/:id/documents?category=`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/documents/upload.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';
import type { UploadConfig } from '../../../../src/modules/documents/upload-config';

describe('POST /cases/:id/documents', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const PDF = Buffer.from('%PDF-1.4 test document');

  async function upload(
    app: ReturnType<typeof buildTestApp>,
    caseId: string,
    userId: string,
    role: string,
    options: { filename?: string; contentType?: string; content?: Buffer; query?: string } = {},
  ) {
    const mp = buildMultipartBody([
      { name: 'file', filename: options.filename ?? 'contract.pdf', contentType: options.contentType ?? 'application/pdf', content: options.content ?? PDF },
    ]);
    return app.inject({
      method: 'POST',
      url: `/cases/${caseId}/documents${options.query ?? '?category=Evidence'}`,
      headers: { ...authHeader(app, userId, role), ...mp.headers },
      payload: mp.payload,
    });
  }

  function setup(uploadConfig?: Partial<UploadConfig>) {
    const storage = new InMemoryObjectStorage();
    const app = buildTestApp(ds, { storage, uploadConfig });
    return { storage, app };
  }

  it('lets the assigned legal_rep upload; stores the exact bytes under cases/{caseId}/{id}; audits it', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      caseId: caseRow.id,
      informationRequestId: null,
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      category: 'Evidence',
      version: 1,
      rootDocumentId: body.id,
      previousVersionId: null,
      uploaderId: repId,
    });
    expect(storage.objects.get(`cases/${caseRow.id}/${body.id}`)?.body.equals(PDF)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.uploaded'`);
    expect(audit.afterValue).toMatchObject({ documentId: body.id, referenceNumber: caseRow.referenceNumber, filename: 'contract.pdf', category: 'Evidence', version: 1 });
    await app.close();
  });

  it('lets a requester in the case department upload', async () => {
    const { app } = setup();
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, requesterId, 'requester');

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('lets a requester who sees the case only as an information-request responder upload', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherMaster = await seedCaseMasterData(ds);
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const res = await upload(app, caseRow.id, responderId, 'requester');

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('lets a legal_manager and an admin upload to a case that is still Assigned', async () => {
    const { app } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const adminId = await seedUserWithRole(ds, 'admin');

    const manager = await upload(app, caseRow.id, managerId, 'legal_manager');
    const admin = await upload(app, caseRow.id, adminId, 'admin');

    expect(manager.statusCode).toBe(201);
    expect(admin.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a viewer, a legal_rep who is not assigned, and a legal_rep who has not accepted (403)', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const unaccepted = await seedCaseWithParties(ds, { status: 'Assigned' });
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');

    const viewer = await upload(app, caseRow.id, viewerId, 'viewer');
    const other = await upload(app, caseRow.id, otherRepId, 'legal_rep');
    const notAccepted = await upload(app, unaccepted.caseRow.id, unaccepted.repId, 'legal_rep');

    expect(viewer.statusCode).toBe(403);
    expect(other.statusCode).toBe(403);
    expect(notAccepted.statusCode).toBe(403);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('rejects an upload to a Closed case with 409', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });

    const res = await upload(app, caseRow.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('returns 404 for a requester who cannot see the case', async () => {
    const { app } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await upload(app, caseRow.id, outsiderId, 'requester');

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a disallowed extension, a mismatched mime type, a missing and an unknown category with 400, storing nothing', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const exe = await upload(app, caseRow.id, repId, 'legal_rep', { filename: 'virus.exe', contentType: 'application/octet-stream' });
    const mismatch = await upload(app, caseRow.id, repId, 'legal_rep', { filename: 'a.pdf', contentType: 'image/png' });
    const noCategory = await upload(app, caseRow.id, repId, 'legal_rep', { query: '' });
    const badCategory = await upload(app, caseRow.id, repId, 'legal_rep', { query: '?category=Secrets' });

    expect(exe.statusCode).toBe(400);
    expect(mismatch.statusCode).toBe(400);
    expect(noCategory.statusCode).toBe(400);
    expect(badCategory.statusCode).toBe(400);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('rejects an oversize file with 413 and leaves nothing in storage or the database', async () => {
    const { app, storage } = setup({ maxBytes: 10 });
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep', { content: Buffer.alloc(64, 1) });

    expect(res.statusCode).toBe(413);
    expect(storage.objects.size).toBe(0);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM documents`);
    expect(count).toBe(0);
    await app.close();
  });

  it('rejects a zero-byte file with 400 and leaves nothing in storage', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep', { content: Buffer.alloc(0) });

    expect(res.statusCode).toBe(400);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('sanitizes path separators out of the filename and keeps them out of the storage key', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await upload(app, caseRow.id, repId, 'legal_rep', { filename: '../../etc/evil.pdf' });

    expect(res.statusCode).toBe(201);
    expect(res.json().filename).toBe('evil.pdf');
    for (const key of storage.objects.keys()) {
      expect(key).toMatch(/^cases\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    }
    await app.close();
  });

  it('keeps a non-ASCII filename and truncates an over-long one to 255 characters, extension intact', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const arabic = await upload(app, caseRow.id, repId, 'legal_rep', { filename: 'عقد-2026.pdf' });
    const long = await upload(app, caseRow.id, repId, 'legal_rep', { filename: `${'a'.repeat(400)}.pdf` });

    expect(arabic.statusCode).toBe(201);
    expect(arabic.json().filename).toBe('عقد-2026.pdf');
    expect(long.statusCode).toBe(201);
    expect(long.json().filename.length).toBe(255);
    expect(long.json().filename.endsWith('.pdf')).toBe(true);
    await app.close();
  });

  it('rejects a non-multipart request with 400', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/documents?category=Evidence`,
      headers: { ...authHeader(app, repId, 'legal_rep'), 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('never lets an upload commit after a concurrent close: the case lock forces 409 and the stored object is cleaned up', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);

    // Hold the case row lock in a separate transaction and close the case inside it.
    const queryRunner = ds.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query(`SELECT id FROM cases WHERE id = $1 FOR UPDATE`, [caseRow.id]);

    const pending = upload(app, caseRow.id, repId, 'legal_rep');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await queryRunner.query(`UPDATE cases SET status = 'Closed' WHERE id = $1`, [caseRow.id]);
    await queryRunner.commitTransaction();
    await queryRunner.release();
    const res = await pending;

    expect(res.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM documents`);
    expect(count).toBe(0);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/documents/upload.test.ts`
Expected: FAIL — `POST /cases/:id/documents` returns 404 "Route not found".

- [ ] **Step 3: Write the schemas**

```typescript
// src/modules/documents/documents.schemas.ts
import { z } from 'zod';
import { DOCUMENT_CATEGORIES } from './upload-config';

export const documentCategorySchema = z.enum(DOCUMENT_CATEGORIES);

export const uploadQuerySchema = z.object({ category: documentCategorySchema });

export const documentResponseSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  informationRequestId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  category: documentCategorySchema,
  version: z.number(),
  rootDocumentId: z.string(),
  previousVersionId: z.string().nullable(),
  uploaderId: z.string(),
  createdAt: z.string(),
});
```

- [ ] **Step 4: Write the service**

```typescript
// src/modules/documents/documents.service.ts
import crypto from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import type { DataSource, EntityManager } from 'typeorm';
import { CaseDocument } from './entities/case-document.entity';
import { Case } from '../cases/entities/case.entity';
import { getCaseById, type Actor } from '../cases/cases.service';
import { loadCaseOrThrow, lockCaseOrThrow } from '../cases/cases.workflow.service';
import { assertCaseWriteEligibility } from '../cases/case-access';
import { logAuditEvent } from '../audit/audit.service';
import { PayloadTooLargeError, ValidationError } from '../../shared/errors';
import type { ObjectStorage } from '../../shared/storage/object-storage';
import { normalizeMimeType, validateUploadFile, type DocumentCategory, type UploadConfig } from './upload-config';

export type DocumentsDeps = { dataSource: DataSource; storage: ObjectStorage; uploadConfig: UploadConfig };
export type IncomingFile = { filename: string; mimeType: string; stream: Readable };
export type UploadPlan = { version: number; rootDocumentId: string | null; previousVersionId: string | null };

export function documentStorageKey(caseId: string, documentId: string): string {
  return `cases/${caseId}/${documentId}`;
}

class SizeLimiter extends Transform {
  bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    super();
    this.maxBytes = maxBytes;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new PayloadTooLargeError(`File exceeds the maximum size of ${this.maxBytes} bytes`));
      return;
    }
    callback(null, chunk);
  }
}

type UploadRequest = {
  caseId: string;
  informationRequestId: string | null;
  category: DocumentCategory;
  auditAction: 'document.uploaded' | 'document.version_uploaded';
  // Runs twice: once unlocked before any bytes are read (fast rejection), and
  // once inside the transaction with the case row locked (the authoritative
  // re-check that closes the race with a concurrent close/reassignment).
  authorize: (manager: EntityManager, caseRow: Case) => Promise<UploadPlan>;
};

// The shared upload pipeline: gate -> pre-check -> validate -> stream to
// storage -> (lock case, re-check, insert row, audit) in one transaction. Any
// failure after the bytes were stored deletes the stored object.
export async function performUpload(
  deps: DocumentsDeps,
  actor: Actor,
  file: IncomingFile,
  request: UploadRequest,
): Promise<CaseDocument> {
  try {
    await getCaseById(deps.dataSource, actor, request.caseId);
    await request.authorize(deps.dataSource.manager, await loadCaseOrThrow(deps.dataSource, request.caseId));
    const { filename } = validateUploadFile(deps.uploadConfig, file.filename, file.mimeType);
    const mimeType = normalizeMimeType(file.mimeType);

    const documentId = crypto.randomUUID();
    const key = documentStorageKey(request.caseId, documentId);
    const limiter = new SizeLimiter(deps.uploadConfig.maxBytes);
    const limited = pipeline(file.stream, limiter, () => undefined);
    try {
      await deps.storage.put(key, limited, mimeType);
      if (limiter.bytes === 0) {
        throw new ValidationError('Empty files cannot be uploaded');
      }
      return await deps.dataSource.transaction(async (manager) => {
        const caseRow = await lockCaseOrThrow(manager, request.caseId);
        const plan = await request.authorize(manager, caseRow);
        const repo = manager.getRepository(CaseDocument);
        const document = await repo.save(
          repo.create({
            id: documentId,
            caseId: request.caseId,
            informationRequestId: request.informationRequestId,
            filename,
            mimeType,
            sizeBytes: limiter.bytes,
            category: request.category,
            version: plan.version,
            rootDocumentId: plan.rootDocumentId ?? documentId,
            previousVersionId: plan.previousVersionId,
            uploaderId: actor.id,
            deletedAt: null,
          }),
        );
        await logAuditEvent(manager, {
          actorId: actor.id,
          caseId: request.caseId,
          action: request.auditAction,
          afterValue: {
            documentId: document.id,
            caseId: request.caseId,
            referenceNumber: caseRow.referenceNumber,
            filename: document.filename,
            category: document.category,
            version: document.version,
            informationRequestId: document.informationRequestId,
          },
        });
        return document;
      });
    } catch (error) {
      limited.destroy();
      await deps.storage.delete(key).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    file.stream.resume();
    throw error;
  }
}

export async function uploadCaseDocument(
  deps: DocumentsDeps,
  actor: Actor,
  caseId: string,
  category: DocumentCategory,
  file: IncomingFile,
): Promise<CaseDocument> {
  return performUpload(deps, actor, file, {
    caseId,
    informationRequestId: null,
    category,
    auditAction: 'document.uploaded',
    authorize: async (_manager, caseRow) => {
      assertCaseWriteEligibility(actor, caseRow);
      return { version: 1, rootDocumentId: null, previousVersionId: null };
    },
  });
}
```

- [ ] **Step 5: Write the routes and register them**

```typescript
// src/modules/documents/documents.routes.ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CaseDocument } from './entities/case-document.entity';
import { uploadCaseDocument, type DocumentsDeps, type IncomingFile } from './documents.service';
import { documentResponseSchema, uploadQuerySchema } from './documents.schemas';
import { caseIdParamsSchema } from '../cases/cases.schemas';
import { ValidationError } from '../../shared/errors';
import type { ObjectStorage } from '../../shared/storage/object-storage';
import type { UploadConfig } from './upload-config';

export type DocumentsRoutesOptions = { storage: ObjectStorage; uploadConfig: UploadConfig };

export function serializeDocument(row: CaseDocument) {
  return {
    id: row.id,
    caseId: row.caseId,
    informationRequestId: row.informationRequestId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    category: row.category,
    version: row.version,
    rootDocumentId: row.rootDocumentId,
    previousVersionId: row.previousVersionId,
    uploaderId: row.uploaderId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function readUpload(request: FastifyRequest): Promise<IncomingFile> {
  if (!request.isMultipart()) {
    throw new ValidationError('Request must be multipart/form-data');
  }
  const part = await request.file();
  if (!part || part.fieldname !== 'file') {
    throw new ValidationError('A file is required in the multipart field "file"');
  }
  return { filename: part.filename, mimeType: part.mimetype, stream: part.file };
}

export default async function documentsRoutes(app: FastifyInstance, options: DocumentsRoutesOptions): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const deps: DocumentsDeps = { dataSource: app.dataSource, storage: options.storage, uploadConfig: options.uploadConfig };

  typedApp.post('/cases/:id/documents', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      params: caseIdParamsSchema,
      querystring: uploadQuerySchema,
      response: { 201: documentResponseSchema },
    },
  }, async (request, reply) => {
    const file = await readUpload(request);
    const document = await uploadCaseDocument(deps, request.user, request.params.id, request.query.category, file);
    reply.status(201).send(serializeDocument(document));
  });
}
```

```typescript
// src/app.ts — add import and registration after app.register(commentsRoutes);
import documentsRoutes from './modules/documents/documents.routes';
// ...
  app.register(documentsRoutes, { storage: options.storage, uploadConfig });
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/documents/upload.test.ts && npx tsc --noEmit`
Expected: PASS (14 tests), `tsc` clean. If the non-ASCII filename test fails because the multipart plugin decodes the header as latin1, confirm `defParamCharset: 'utf8'` is present in the `multipart` registration in `src/app.ts` (Task 2 added it) and record any other fix as a ledger ruling.

- [ ] **Step 7: Commit**

Create `decisions/documents-comments/task-06-case-document-upload.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/documents/documents.schemas.ts src/modules/documents/documents.service.ts src/modules/documents/documents.routes.ts src/app.ts test/integration/modules/documents/upload.test.ts decisions.md decisions/documents-comments/task-06-case-document-upload.md
git commit -m "feat: POST /cases/:id/documents - streamed, validated, transactional upload"
```

---

### Task 7: List, version history, download

**Files:**
- Create: `src/modules/documents/content-disposition.ts`
- Modify: `src/modules/documents/documents.schemas.ts`
- Modify: `src/modules/documents/documents.service.ts`
- Modify: `src/modules/documents/documents.routes.ts`
- Test: `test/unit/modules/documents/content-disposition.test.ts`
- Test: `test/integration/modules/documents/list-and-download.test.ts`

**Interfaces:**
- Consumes: `CaseDocument`, `seedDocument`, `InMemoryObjectStorage.seed`, `documentStorageKey`, `DocumentsDeps`.
- Produces: `contentDispositionHeader(disposition: 'attachment' | 'inline', filename: string): string`; `listCaseDocuments(dataSource, actor, caseId, options: { informationRequestId?: string; includeHistory: boolean }): Promise<CaseDocument[]>`; `listDocumentVersions(dataSource, actor, documentId): Promise<CaseDocument[]>`; `getDocumentForDownload(dataSource, actor, documentId): Promise<CaseDocument>`; `findLiveDocument(source: DataSource | EntityManager, documentId: string): Promise<CaseDocument>` (404 if missing/deleted) — reused by Tasks 8 and 10; schemas `documentIdParamsSchema`, `listDocumentsQuerySchema`, `downloadQuerySchema`, `documentListResponseSchema`; routes `GET /cases/:id/documents`, `GET /documents/:id/versions`, `GET /documents/:id/download`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/modules/documents/content-disposition.test.ts
import { describe, it, expect } from 'vitest';
import { contentDispositionHeader } from '../../../../src/modules/documents/content-disposition';

describe('contentDispositionHeader', () => {
  it('builds an attachment header with an ASCII fallback and an RFC 5987 name', () => {
    expect(contentDispositionHeader('attachment', 'contract.pdf')).toBe(`attachment; filename="contract.pdf"; filename*=UTF-8''contract.pdf`);
  });

  it('supports inline preview', () => {
    expect(contentDispositionHeader('inline', 'a.png')).toMatch(/^inline; /);
  });

  it('encodes non-ASCII names and keeps a safe ASCII fallback', () => {
    const header = contentDispositionHeader('attachment', 'عقد.pdf');
    expect(header).toContain(`filename*=UTF-8''%D8%B9%D9%82%D8%AF.pdf`);
    expect(header).toContain('filename="___.pdf"');
  });

  it('neutralises quotes, backslashes and header-injection characters', () => {
    const header = contentDispositionHeader('attachment', 'a"b\\c\r\nX-Evil: 1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('filename="')[1].split('";')[0]).not.toMatch(/["\\]/);
  });
});
```

```typescript
// test/integration/modules/documents/list-and-download.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedDocument } from '../../helpers/seed-document';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('document list, versions and download', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  function setup() {
    const storage = new InMemoryObjectStorage();
    return { storage, app: buildTestApp(ds, { storage }) };
  }

  async function twoVersionChain(caseId: string, uploaderId: string) {
    const v1 = await seedDocument(ds, { caseId, uploaderId, filename: 'v1.pdf' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const v2 = await seedDocument(ds, { caseId, uploaderId, filename: 'v2.pdf', version: 2, rootDocumentId: v1.id, previousVersionId: v1.id });
    return { v1, v2 };
  }

  it('lists only the head of each version chain, newest first, for anyone who can see the case', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const { v2 } = await twoVersionChain(caseRow.id, repId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const other = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'other.pdf' });

    for (const [id, role] of [[repId, 'legal_rep'], [requesterId, 'requester'], [viewerId, 'viewer']] as const) {
      const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, id, role) });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((d: { id: string }) => d.id)).toEqual([other.id, v2.id]);
    }
    await app.close();
  });

  it('includeHistory=true returns every non-deleted version; deleted rows never appear', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const { v1, v2 } = await twoVersionChain(caseRow.id, repId);
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents?includeHistory=true`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.json().map((d: { id: string }) => d.id).sort()).toEqual([v1.id, v2.id].sort());
    await app.close();
  });

  it('filters by informationRequestId', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId });
    const attachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: requesterId, informationRequestId: request.id });
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents?informationRequestId=${request.id}`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.json().map((d: { id: string }) => d.id)).toEqual([attachment.id]);
    await app.close();
  });

  it('returns 404 when listing documents of a case the caller cannot see', async () => {
    const { app } = setup();
    await app.ready();
    const { caseRow } = await seedCaseWithParties(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, outsiderId, 'requester') });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the whole non-deleted chain ascending from any member id', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const { v1, v2 } = await twoVersionChain(caseRow.id, repId);

    const fromOld = await app.inject({ method: 'GET', url: `/documents/${v1.id}/versions`, headers: authHeader(app, repId, 'legal_rep') });
    const fromHead = await app.inject({ method: 'GET', url: `/documents/${v2.id}/versions`, headers: authHeader(app, repId, 'legal_rep') });

    expect(fromOld.json().map((d: { version: number }) => d.version)).toEqual([1, 2]);
    expect(fromHead.json().map((d: { id: string }) => d.id)).toEqual([v1.id, v2.id]);
    await app.close();
  });

  it('returns 404 for the versions of a deleted or invisible document', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });
    const live = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const gone = await app.inject({ method: 'GET', url: `/documents/${deleted.id}/versions`, headers: authHeader(app, repId, 'legal_rep') });
    const hidden = await app.inject({ method: 'GET', url: `/documents/${live.id}/versions`, headers: authHeader(app, outsiderId, 'requester') });

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });

  it('streams the exact bytes with attachment headers, and inline when asked', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const bytes = Buffer.from('%PDF-1.4 real bytes');
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'عقد 2026.pdf', sizeBytes: bytes.length });
    storage.seed(`cases/${caseRow.id}/${doc.id}`, bytes, 'application/pdf');

    const attachment = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download`, headers: authHeader(app, repId, 'legal_rep') });
    const inline = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download?disposition=inline`, headers: authHeader(app, repId, 'legal_rep') });

    expect(attachment.statusCode).toBe(200);
    expect(attachment.rawPayload.equals(bytes)).toBe(true);
    expect(attachment.headers['content-type']).toBe('application/pdf');
    expect(attachment.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(attachment.headers['content-disposition']).toContain(`filename*=UTF-8''%D8%B9%D9%82%D8%AF%202026.pdf`);
    expect(attachment.headers['x-content-type-options']).toBe('nosniff');
    expect(inline.headers['content-disposition']).toMatch(/^inline; /);
    await app.close();
  });

  it('lets a requester who is only an information-request responder download', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherMaster = await seedCaseMasterData(ds);
    const responderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    storage.seed(`cases/${caseRow.id}/${doc.id}`, Buffer.from('x'), 'application/pdf');

    const res = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download`, headers: authHeader(app, responderId, 'requester') });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 404 downloading a deleted document or one on an invisible case, and 400 for a bad disposition', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });
    const live = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const gone = await app.inject({ method: 'GET', url: `/documents/${deleted.id}/download`, headers: authHeader(app, repId, 'legal_rep') });
    const hidden = await app.inject({ method: 'GET', url: `/documents/${live.id}/download`, headers: authHeader(app, outsiderId, 'requester') });
    const bad = await app.inject({ method: 'GET', url: `/documents/${live.id}/download?disposition=evil`, headers: authHeader(app, repId, 'legal_rep') });

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/modules/documents/content-disposition.test.ts test/integration/modules/documents/list-and-download.test.ts`
Expected: FAIL — `Cannot find module '.../content-disposition'` and 404 on the new routes.

- [ ] **Step 3: Implement the header helper**

```typescript
// src/modules/documents/content-disposition.ts
export function contentDispositionHeader(disposition: 'attachment' | 'inline', filename: string): string {
  // ASCII fallback: printable ASCII only, no quotes/backslashes. Control and
  // non-ASCII characters (including CR/LF) become "_".
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 5987 percent-encoding, additionally escaping the characters
  // encodeURIComponent leaves alone but RFC 5987 does not allow.
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
```

- [ ] **Step 4: Extend the schemas**

```typescript
// src/modules/documents/documents.schemas.ts — append
export const documentIdParamsSchema = z.object({ id: z.string().uuid() });

export const listDocumentsQuerySchema = z.object({
  informationRequestId: z.string().uuid().optional(),
  includeHistory: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

export const downloadQuerySchema = z.object({
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
});

export const documentListResponseSchema = z.array(documentResponseSchema);
```

- [ ] **Step 5: Extend the service**

```typescript
// src/modules/documents/documents.service.ts — add imports
import { IsNull } from 'typeorm';
import { NotFoundError } from '../../shared/errors';           // add to the existing errors import

// append at the end of the file
export async function findLiveDocument(source: DataSource | EntityManager, documentId: string): Promise<CaseDocument> {
  const document = await source.getRepository(CaseDocument).findOne({ where: { id: documentId, deletedAt: IsNull() } });
  if (!document) {
    throw new NotFoundError('Document not found');
  }
  return document;
}

export async function listCaseDocuments(
  dataSource: DataSource,
  actor: Actor,
  caseId: string,
  options: { informationRequestId?: string; includeHistory: boolean },
): Promise<CaseDocument[]> {
  await getCaseById(dataSource, actor, caseId);
  const rows = await dataSource.getRepository(CaseDocument).find({
    where: {
      caseId,
      deletedAt: IsNull(),
      ...(options.informationRequestId ? { informationRequestId: options.informationRequestId } : {}),
    },
    order: { createdAt: 'DESC' },
  });
  if (options.includeHistory) {
    return rows;
  }
  // Head of each chain = highest version among the non-deleted rows.
  const heads = new Map<string, CaseDocument>();
  for (const row of rows) {
    const current = heads.get(row.rootDocumentId);
    if (!current || row.version > current.version) {
      heads.set(row.rootDocumentId, row);
    }
  }
  return rows.filter((row) => heads.get(row.rootDocumentId)?.id === row.id);
}

export async function listDocumentVersions(dataSource: DataSource, actor: Actor, documentId: string): Promise<CaseDocument[]> {
  const document = await findLiveDocument(dataSource, documentId);
  await getCaseById(dataSource, actor, document.caseId);
  return dataSource.getRepository(CaseDocument).find({
    where: { rootDocumentId: document.rootDocumentId, deletedAt: IsNull() },
    order: { version: 'ASC' },
  });
}

export async function getDocumentForDownload(dataSource: DataSource, actor: Actor, documentId: string): Promise<CaseDocument> {
  const document = await findLiveDocument(dataSource, documentId);
  await getCaseById(dataSource, actor, document.caseId);
  return document;
}
```

- [ ] **Step 6: Extend the routes**

```typescript
// src/modules/documents/documents.routes.ts — update imports
import {
  getDocumentForDownload,
  listCaseDocuments,
  listDocumentVersions,
  documentStorageKey,
  uploadCaseDocument,
  type DocumentsDeps,
  type IncomingFile,
} from './documents.service';
import {
  documentIdParamsSchema,
  documentListResponseSchema,
  documentResponseSchema,
  downloadQuerySchema,
  listDocumentsQuerySchema,
  uploadQuerySchema,
} from './documents.schemas';
import { contentDispositionHeader } from './content-disposition';

// add inside documentsRoutes(), before the POST route
  typedApp.get('/cases/:id/documents', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      params: caseIdParamsSchema,
      querystring: listDocumentsQuerySchema,
      response: { 200: documentListResponseSchema },
    },
  }, async (request) => {
    const rows = await listCaseDocuments(app.dataSource, request.user, request.params.id, {
      informationRequestId: request.query.informationRequestId,
      includeHistory: request.query.includeHistory,
    });
    return rows.map(serializeDocument);
  });

  typedApp.get('/documents/:id/versions', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      params: documentIdParamsSchema,
      response: { 200: documentListResponseSchema },
    },
  }, async (request) => {
    const rows = await listDocumentVersions(app.dataSource, request.user, request.params.id);
    return rows.map(serializeDocument);
  });

  typedApp.get('/documents/:id/download', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      params: documentIdParamsSchema,
      querystring: downloadQuerySchema,
    },
  }, async (request, reply) => {
    const document = await getDocumentForDownload(app.dataSource, request.user, request.params.id);
    const stream = await options.storage.get(documentStorageKey(document.caseId, document.id));
    reply
      .header('Content-Type', document.mimeType)
      .header('Content-Disposition', contentDispositionHeader(request.query.disposition, document.filename))
      .header('Content-Length', String(document.sizeBytes))
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(stream);
  });
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run test/unit/modules/documents test/integration/modules/documents && npx tsc --noEmit`
Expected: PASS (Task 6's 14 tests plus these 9 and 4 unit tests), `tsc` clean.

- [ ] **Step 8: Commit**

Create `decisions/documents-comments/task-07-list-versions-download.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/documents test/unit/modules/documents/content-disposition.test.ts test/integration/modules/documents/list-and-download.test.ts decisions.md decisions/documents-comments/task-07-list-versions-download.md
git commit -m "feat: document list, version history and streamed download"
```

---

### Task 8: Upload a new version

**Files:**
- Modify: `src/modules/documents/documents.schemas.ts`
- Modify: `src/modules/documents/documents.service.ts`
- Modify: `src/modules/documents/documents.routes.ts`
- Test: `test/integration/modules/documents/new-version.test.ts`

**Interfaces:**
- Consumes: `performUpload`, `UploadPlan`, `findLiveDocument`, `assertCaseWriteEligibility`, `DocumentsDeps`, `IncomingFile`.
- Produces: `uploadNewVersion(deps, actor, documentId, category: DocumentCategory | undefined, file): Promise<CaseDocument>`; schema `newVersionQuerySchema`; route `POST /documents/:id/versions?category=`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/documents/new-version.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedDocument } from '../../helpers/seed-document';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('POST /documents/:id/versions', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const V2 = Buffer.from('%PDF-1.4 second version');

  async function uploadVersion(app: ReturnType<typeof buildTestApp>, documentId: string, userId: string, role: string, query = '') {
    const mp = buildMultipartBody([{ name: 'file', filename: 'contract-v2.pdf', contentType: 'application/pdf', content: V2 }]);
    return app.inject({
      method: 'POST',
      url: `/documents/${documentId}/versions${query}`,
      headers: { ...authHeader(app, userId, role), ...mp.headers },
      payload: mp.payload,
    });
  }

  function setup() {
    const storage = new InMemoryObjectStorage();
    return { storage, app: buildTestApp(ds, { storage }) };
  }

  it('creates version 2 linked to version 1, inheriting the category, keeping the old bytes, and audits it', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Contract' });
    storage.seed(`cases/${caseRow.id}/${v1.id}`, Buffer.from('v1 bytes'), 'application/pdf');

    const res = await uploadVersion(app, v1.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(201);
    const v2 = res.json();
    expect(v2).toMatchObject({ version: 2, rootDocumentId: v1.id, previousVersionId: v1.id, category: 'Contract', informationRequestId: null });
    expect(storage.objects.get(`cases/${caseRow.id}/${v1.id}`)?.body.toString()).toBe('v1 bytes');
    expect(storage.objects.get(`cases/${caseRow.id}/${v2.id}`)?.body.equals(V2)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.version_uploaded'`);
    expect(audit.afterValue).toMatchObject({ documentId: v2.id, version: 2, referenceNumber: caseRow.referenceNumber });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, repId, 'legal_rep') });
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([v2.id]);
    await app.close();
  });

  it('lets the caller override the category', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, category: 'Evidence' });

    const res = await uploadVersion(app, v1.id, repId, 'legal_rep', '?category=Legal%20Opinion');

    expect(res.statusCode).toBe(201);
    expect(res.json().category).toBe('Legal Opinion');
    await app.close();
  });

  it('lets any eligible writer (not just the original uploader) add a version', async () => {
    const { app } = setup();
    await app.ready();
    const { requesterId, caseRow, repId } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    const res = await uploadVersion(app, v1.id, requesterId, 'requester');

    expect(res.statusCode).toBe(201);
    expect(res.json().uploaderId).toBe(requesterId);
    await app.close();
  });

  it('rejects versioning anything but the latest version with 409', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, version: 2, rootDocumentId: v1.id, previousVersionId: v1.id });

    const res = await uploadVersion(app, v1.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects versioning an information-request attachment with 409', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId });
    const attachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: requesterId, informationRequestId: request.id });

    const res = await uploadVersion(app, attachment.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects a viewer (403), an unassigned legal_rep (403) and a Closed case (409)', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const closed = await seedCaseWithParties(ds, { status: 'Closed' });
    const closedDoc = await seedDocument(ds, { caseId: closed.caseRow.id, uploaderId: closed.repId });
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');

    const viewer = await uploadVersion(app, v1.id, viewerId, 'viewer');
    const other = await uploadVersion(app, v1.id, otherRepId, 'legal_rep');
    const onClosed = await uploadVersion(app, closedDoc.id, closed.repId, 'legal_rep');

    expect(viewer.statusCode).toBe(403);
    expect(other.statusCode).toBe(403);
    expect(onClosed.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('returns 404 for a deleted document and for a case the caller cannot see', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });
    const live = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const gone = await uploadVersion(app, deleted.id, repId, 'legal_rep');
    const hidden = await uploadVersion(app, live.id, outsiderId, 'requester');

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/documents/new-version.test.ts`
Expected: FAIL — `POST /documents/:id/versions` returns 404 "Route not found".

- [ ] **Step 3: Implement**

```typescript
// src/modules/documents/documents.schemas.ts — append
export const newVersionQuerySchema = z.object({ category: documentCategorySchema.optional() });
```

```typescript
// src/modules/documents/documents.service.ts — append (imports already present from Tasks 6/7; add ConflictError to the errors import)
import { ConflictError } from '../../shared/errors';

export async function uploadNewVersion(
  deps: DocumentsDeps,
  actor: Actor,
  documentId: string,
  category: DocumentCategory | undefined,
  file: IncomingFile,
): Promise<CaseDocument> {
  let target: CaseDocument;
  try {
    target = await findLiveDocument(deps.dataSource, documentId);
  } catch (error) {
    file.stream.resume();
    throw error;
  }
  return performUpload(deps, actor, file, {
    caseId: target.caseId,
    informationRequestId: null,
    category: category ?? target.category,
    auditAction: 'document.version_uploaded',
    authorize: async (manager, caseRow) => {
      assertCaseWriteEligibility(actor, caseRow);
      const repo = manager.getRepository(CaseDocument);
      const current = await findLiveDocument(manager, documentId);
      if (current.informationRequestId) {
        throw new ConflictError('Information-request attachments cannot be versioned');
      }
      const head = await repo.findOne({
        where: { rootDocumentId: current.rootDocumentId, deletedAt: IsNull() },
        order: { version: 'DESC' },
      });
      if (!head || head.id !== current.id) {
        throw new ConflictError('Only the latest version of a document can be superseded');
      }
      // Number past every version ever stored for this chain, deleted ones
      // included, so a version number is never reused.
      const { max } = (await repo
        .createQueryBuilder('d')
        .select('MAX(d."version")', 'max')
        .where('d."rootDocumentId" = :root', { root: current.rootDocumentId })
        .getRawOne<{ max: number | null }>()) ?? { max: current.version };
      return { version: Number(max ?? current.version) + 1, rootDocumentId: current.rootDocumentId, previousVersionId: current.id };
    },
  });
}
```

```typescript
// src/modules/documents/documents.routes.ts — add to imports and add the route after the POST /cases/:id/documents route
import { uploadNewVersion } from './documents.service';          // add to the existing service import
import { newVersionQuerySchema } from './documents.schemas';     // add to the existing schemas import

  typedApp.post('/documents/:id/versions', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      params: documentIdParamsSchema,
      querystring: newVersionQuerySchema,
      response: { 201: documentResponseSchema },
    },
  }, async (request, reply) => {
    const file = await readUpload(request);
    const document = await uploadNewVersion(deps, request.user, request.params.id, request.query.category, file);
    reply.status(201).send(serializeDocument(document));
  });
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/documents && npx tsc --noEmit`
Expected: PASS (all documents tests so far), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/documents-comments/task-08-new-version.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/documents test/integration/modules/documents/new-version.test.ts decisions.md decisions/documents-comments/task-08-new-version.md
git commit -m "feat: POST /documents/:id/versions - upload a new version"
```

---

### Task 9: Information-request attachments

**Files:**
- Modify: `src/modules/documents/documents.service.ts`
- Modify: `src/modules/documents/documents.routes.ts`
- Test: `test/integration/modules/documents/information-request-attachments.test.ts`

**Interfaces:**
- Consumes: `performUpload`, `InformationRequest` entity, `uploadQuerySchema`, `informationRequestIdParamsSchema` from `../information-requests/information-requests.schemas`.
- Produces: `uploadInformationRequestAttachment(deps, actor, requestId, category, file): Promise<CaseDocument>`; route `POST /information-requests/:id/attachments?category=`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/documents/information-request-attachments.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('POST /information-requests/:id/attachments', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  async function attach(app: ReturnType<typeof buildTestApp>, requestId: string, userId: string, role: string) {
    const mp = buildMultipartBody([{ name: 'file', filename: 'answer.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 answer') }]);
    return app.inject({
      method: 'POST',
      url: `/information-requests/${requestId}/attachments?category=Correspondence`,
      headers: { ...authHeader(app, userId, role), ...mp.headers },
      payload: mp.payload,
    });
  }

  function setup() {
    const storage = new InMemoryObjectStorage();
    return { storage, app: buildTestApp(ds, { storage }) };
  }

  it('lets the responder attach a file to an open request; it is linked to the request and audited', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const res = await attach(app, request.id, responderId, 'requester');

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ caseId: caseRow.id, informationRequestId: request.id, category: 'Correspondence', version: 1, uploaderId: responderId });
    expect(storage.objects.has(`cases/${caseRow.id}/${body.id}`)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.uploaded'`);
    expect(audit.afterValue).toMatchObject({ informationRequestId: request.id, referenceNumber: caseRow.referenceNumber });
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents?informationRequestId=${request.id}`, headers: authHeader(app, repId, 'legal_rep') });
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([body.id]);
    await app.close();
  });

  it('lets a responder of any role attach, including a legal_rep and a viewer (AC-15: only the responder answers)', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const byRep = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: otherRepId });
    const byViewer = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: viewerId });

    const repRes = await attach(app, byRep.id, otherRepId, 'legal_rep');
    const viewerRes = await attach(app, byViewer.id, viewerId, 'viewer');

    expect(repRes.statusCode).toBe(201);
    expect(viewerRes.statusCode).toBe(201);
    await app.close();
  });

  it('rejects anyone who is not the responder, including the raising lawyer, with 403', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const raiser = await attach(app, request.id, repId, 'legal_rep');
    const colleague = await attach(app, request.id, requesterId, 'requester');

    expect(raiser.statusCode).toBe(403);
    expect(colleague.statusCode).toBe(403);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('rejects an answered or superseded request with 409', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const superseded = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'superseded' });

    const a = await attach(app, answered.id, responderId, 'requester');
    const s = await attach(app, superseded.id, responderId, 'requester');

    expect(a.statusCode).toBe(409);
    expect(s.statusCode).toBe(409);
    expect(storage.objects.size).toBe(0);
    await app.close();
  });

  it('allows attaching again to the open request created by reopening', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const first = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'superseded' });
    const reopened = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, reopenedFromId: first.id });

    const res = await attach(app, reopened.id, responderId, 'requester');

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('returns 404 for an unknown request id', async () => {
    const { app } = setup();
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');

    const res = await attach(app, '6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e', userId, 'requester');

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/documents/information-request-attachments.test.ts`
Expected: FAIL — `POST /information-requests/:id/attachments` returns 404 "Route not found".

- [ ] **Step 3: Implement**

```typescript
// src/modules/documents/documents.service.ts — add imports
import { InformationRequest } from '../information-requests/entities/information-request.entity';
import { ForbiddenError } from '../../shared/errors';           // add to the existing errors import

// append at the end of the file
export async function uploadInformationRequestAttachment(
  deps: DocumentsDeps,
  actor: Actor,
  requestId: string,
  category: DocumentCategory,
  file: IncomingFile,
): Promise<CaseDocument> {
  let informationRequest: InformationRequest | null;
  try {
    informationRequest = await deps.dataSource.getRepository(InformationRequest).findOne({ where: { id: requestId } });
    if (!informationRequest) {
      throw new NotFoundError('Information request not found');
    }
  } catch (error) {
    file.stream.resume();
    throw error;
  }
  // Only the responder may attach (AC-15), whatever their role, and only while
  // the request is open — so the general write-eligibility rule (which bars
  // viewers) deliberately does not apply here.
  return performUpload(deps, actor, file, {
    caseId: informationRequest.caseId,
    informationRequestId: informationRequest.id,
    category,
    auditAction: 'document.uploaded',
    authorize: async (manager) => {
      const current = await manager.getRepository(InformationRequest).findOne({ where: { id: requestId } });
      if (!current) {
        throw new NotFoundError('Information request not found');
      }
      if (current.responderId !== actor.id) {
        throw new ForbiddenError('Only the assigned responder can attach files to this information request');
      }
      if (current.status !== 'open') {
        throw new ConflictError('Attachments can only be added while the information request is open');
      }
      return { version: 1, rootDocumentId: null, previousVersionId: null };
    },
  });
}
```

```typescript
// src/modules/documents/documents.routes.ts — add imports and the route
import { uploadInformationRequestAttachment } from './documents.service';                        // add to the existing service import
import { informationRequestIdParamsSchema } from '../information-requests/information-requests.schemas';

  typedApp.post('/information-requests/:id/attachments', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      params: informationRequestIdParamsSchema,
      querystring: uploadQuerySchema,
      response: { 201: documentResponseSchema },
    },
  }, async (request, reply) => {
    const file = await readUpload(request);
    const document = await uploadInformationRequestAttachment(deps, request.user, request.params.id, request.query.category, file);
    reply.status(201).send(serializeDocument(document));
  });
```

Note: `performUpload` first calls `getCaseById` (the visibility gate) before `authorize`, so a responder who is a `requester` in another department passes the gate through the information-request responder link (case core's AC-04 rule, already implemented).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/documents && npx tsc --noEmit`
Expected: PASS (all documents tests so far), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/documents-comments/task-09-information-request-attachments.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/documents test/integration/modules/documents/information-request-attachments.test.ts decisions.md decisions/documents-comments/task-09-information-request-attachments.md
git commit -m "feat: POST /information-requests/:id/attachments - responder attachments"
```

---

### Task 10: Soft-delete a document

**Files:**
- Modify: `src/modules/documents/documents.service.ts`
- Modify: `src/modules/documents/documents.routes.ts`
- Test: `test/integration/modules/documents/delete.test.ts`

**Interfaces:**
- Consumes: `findLiveDocument`, `assertCaseNotClosed`, `lockCaseOrThrow`, `InformationRequest`.
- Produces: `deleteDocument(dataSource, actor, documentId): Promise<void>`; route `DELETE /documents/:id` (204).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/documents/delete.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedDocument } from '../../helpers/seed-document';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { authHeader } from '../../helpers/auth-header';
import { buildMultipartBody } from '../../helpers/multipart';
import { InMemoryObjectStorage } from '../../helpers/in-memory-storage';

describe('DELETE /documents/:id', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  function setup() {
    const storage = new InMemoryObjectStorage();
    return { storage, app: buildTestApp(ds, { storage }) };
  }

  const del = (app: ReturnType<typeof buildTestApp>, id: string, userId: string, role: string) =>
    app.inject({ method: 'DELETE', url: `/documents/${id}`, headers: authHeader(app, userId, role) });

  it('lets the uploader soft-delete: 204, hidden from list and download, bytes retained, audited', async () => {
    const { app, storage } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    storage.seed(`cases/${caseRow.id}/${doc.id}`, Buffer.from('bytes'), 'application/pdf');

    const res = await del(app, doc.id, repId, 'legal_rep');
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, repId, 'legal_rep') });
    const download = await app.inject({ method: 'GET', url: `/documents/${doc.id}/download`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(204);
    expect(list.json()).toEqual([]);
    expect(download.statusCode).toBe(404);
    expect(storage.objects.has(`cases/${caseRow.id}/${doc.id}`)).toBe(true);
    const [audit] = await ds.query(`SELECT "afterValue" FROM audit_log WHERE action = 'document.deleted'`);
    expect(audit.afterValue).toMatchObject({ documentId: doc.id, referenceNumber: caseRow.referenceNumber });
    await app.close();
  });

  it('rejects anyone but the uploader, including an admin and a legal_manager, with 403', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const adminId = await seedUserWithRole(ds, 'admin');
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const admin = await del(app, doc.id, adminId, 'admin');
    const manager = await del(app, doc.id, managerId, 'legal_manager');

    expect(admin.statusCode).toBe(403);
    expect(manager.statusCode).toBe(403);
    await app.close();
  });

  it('rejects deleting on a Closed case with 409, even for the uploader', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });
    const doc = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });

    const res = await del(app, doc.id, repId, 'legal_rep');

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 404 for a deleted document and for a case the caller cannot see', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const deleted = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, deletedAt: new Date() });
    const live = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId });
    const otherMaster = await seedCaseMasterData(ds);
    const outsiderId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });

    const gone = await del(app, deleted.id, repId, 'legal_rep');
    const hidden = await del(app, live.id, outsiderId, 'requester');

    expect(gone.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });

  it('promotes the previous version to head when the latest version is deleted, and numbering never reuses a version number', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds);
    const v1 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'v1.pdf' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const v2 = await seedDocument(ds, { caseId: caseRow.id, uploaderId: repId, filename: 'v2.pdf', version: 2, rootDocumentId: v1.id, previousVersionId: v1.id });

    const res = await del(app, v2.id, repId, 'legal_rep');
    const list = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}/documents`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(204);
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([v1.id]);

    const mp = buildMultipartBody([{ name: 'file', filename: 'v3.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 third') }]);
    const next = await app.inject({
      method: 'POST',
      url: `/documents/${v1.id}/versions`,
      headers: { ...authHeader(app, repId, 'legal_rep'), ...mp.headers },
      payload: mp.payload,
    });
    expect(next.statusCode).toBe(201);
    expect(next.json()).toMatchObject({ version: 3, previousVersionId: v1.id, rootDocumentId: v1.id });
    await app.close();
  });

  it('lets the responder delete their attachment while the request is open, but not after it is answered', async () => {
    const { app } = setup();
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const open = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'done' });
    const openAttachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: responderId, informationRequestId: open.id });
    const answeredAttachment = await seedDocument(ds, { caseId: caseRow.id, uploaderId: responderId, informationRequestId: answered.id });

    const whileOpen = await del(app, openAttachment.id, responderId, 'requester');
    const afterAnswer = await del(app, answeredAttachment.id, responderId, 'requester');

    expect(whileOpen.statusCode).toBe(204);
    expect(afterAnswer.statusCode).toBe(409);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/documents/delete.test.ts`
Expected: FAIL — `DELETE /documents/:id` returns 404 "Route not found".

- [ ] **Step 3: Implement**

```typescript
// src/modules/documents/documents.service.ts — add to imports
import { assertCaseNotClosed } from '../cases/case-access';       // add to the existing case-access import

// append at the end of the file
export async function deleteDocument(dataSource: DataSource, actor: Actor, documentId: string): Promise<void> {
  const preliminary = await findLiveDocument(dataSource, documentId);
  await getCaseById(dataSource, actor, preliminary.caseId);
  await dataSource.transaction(async (manager) => {
    const caseRow = await lockCaseOrThrow(manager, preliminary.caseId);
    const document = await findLiveDocument(manager, documentId);
    assertCaseNotClosed(caseRow);
    if (document.uploaderId !== actor.id) {
      throw new ForbiddenError('Only the uploader can delete this document');
    }
    if (document.informationRequestId) {
      const informationRequest = await manager.getRepository(InformationRequest).findOne({ where: { id: document.informationRequestId } });
      if (informationRequest && informationRequest.status !== 'open') {
        throw new ConflictError('Attachments cannot be deleted once the information request has been answered');
      }
    }

    document.deletedAt = new Date();
    await manager.getRepository(CaseDocument).save(document);
    await logAuditEvent(manager, {
      actorId: actor.id,
      caseId: document.caseId,
      action: 'document.deleted',
      beforeValue: { documentId: document.id, filename: document.filename, version: document.version },
      afterValue: {
        documentId: document.id,
        caseId: document.caseId,
        referenceNumber: caseRow.referenceNumber,
        filename: document.filename,
        version: document.version,
        deletedAt: document.deletedAt,
      },
    });
  });
}
```

```typescript
// src/modules/documents/documents.routes.ts — add to the service import, then add the route
import { deleteDocument } from './documents.service';            // add to the existing service import

  typedApp.delete('/documents/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Documents'],
      security: [{ bearerAuth: [] }],
      params: documentIdParamsSchema,
    },
  }, async (request, reply) => {
    await deleteDocument(app.dataSource, request.user, request.params.id);
    reply.status(204).send();
  });
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/documents test/integration/modules/comments && npx tsc --noEmit`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/documents-comments/task-10-document-delete.md` and add one bullet to the top of the `## documents-comments` section in `decisions.md`.

```bash
git add src/modules/documents test/integration/modules/documents/delete.test.ts decisions.md decisions/documents-comments/task-10-document-delete.md
git commit -m "feat: DELETE /documents/:id - uploader soft delete"
```

---

## Final verification

After Task 10, run the whole backend suite on a genuinely fresh test container and the typecheck. The `-v` is required: the test Postgres uses a `tmpfs` data directory, so only a recreated container guarantees empty state.

```bash
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up -d
sleep 3
npx vitest run test/unit test/integration
npx tsc --noEmit
```

Expected: all test files pass (previously 217 tests across 50 files; this plan adds roughly 90 more), `tsc` clean. Optionally run the S3 smoke test against the dev MinIO:
`docker compose -f docker-compose.dev.yml up -d minio` then
`S3_SMOKE_TEST=1 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY_ID=lcms S3_SECRET_ACCESS_KEY=lcms12345 npx vitest run test/integration/storage`.
