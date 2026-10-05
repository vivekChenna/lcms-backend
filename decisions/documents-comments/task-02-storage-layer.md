# Task 2 — Storage layer, app wiring, test helpers

**Date:** 2026-10-06

**What:** Added the `ObjectStorage` interface and an S3-compatible implementation (`S3ObjectStorage`, `createS3StorageFromEnv`), changed `buildApp(dataSource, options)` to take a storage and upload config, registered `@fastify/multipart`, wired `server.ts` to create the bucket and parse upload config, and added test helpers (in-memory storage fake, multipart body builder, auth-header helper, `buildTestApp` with optional storage/config overrides). The multipart option `defParamCharset` from the plan does not exist in `@fastify/multipart` 10.1.2 (its busboy 3.x has `defCharset`), so the registration uses `defCharset: 'utf8'`, which is also busboy's default.

**Why:** Services depend on an `ObjectStorage` abstraction so MinIO/S3 can back production while tests use an in-memory fake with no network. The multipart `fileSize` limit is set one byte above the configured max so the service's own size limiter produces the project's 413 error first.
