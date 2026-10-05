# Task 1 — Upload environment config, file validation rules, and 413 error

**Date:** 2026-10-06

**What:** Added npm dependencies for multipart and S3 support (`@fastify/multipart`, `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`), new environment variables for S3 configuration and upload limits, a new `PayloadTooLargeError` class for 413 HTTP responses, and a comprehensive `upload-config` module providing validation functions for file uploads including extension/MIME-type checking, filename sanitization, and configuration parsing.

**Why:** The documents-comments workflow requires multipart file upload handling and S3-compatible object storage. This task establishes the foundation: npm dependencies, environment configuration to support multiple deployment scenarios (MinIO in dev, AWS S3 in prod), error handling for oversized payloads, and centralized validation rules for file uploads. These validation rules prevent security issues (directory traversal, malicious extensions, control characters) and enforce consistent file-type policies. Subsequent tasks build the upload endpoints, document entities, and comment system on top of these exports.
