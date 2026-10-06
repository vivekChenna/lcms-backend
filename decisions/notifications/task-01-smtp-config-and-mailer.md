# Task 1 — SMTP config, Nodemailer mailer, recording mailer fake

**Date:** 2026-10-06

**What:** Added npm dependencies for SMTP email support (`nodemailer`, `@types/nodemailer`), new environment variables for SMTP configuration (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, MAIL_FROM) with sensible defaults, a core `Mailer` interface and `MailMessage` type, a `NodemailerMailer` implementation that sends emails through Nodemailer, a `createMailerFromEnv` factory function that validates required configuration, and a `RecordingMailer` test fake that captures sent messages and supports fault injection for testing retry logic.

**Why:** The notifications feature requires a robust email delivery system. This task establishes the foundation: npm dependencies for production email delivery, environment configuration to support multiple SMTP servers and authentication schemes (MailHog in dev, real SMTP in prod), a clean interface-based design for swappable mailer implementations, and comprehensive test helpers to validate email logic without requiring a real SMTP server. Subsequent tasks build the email dispatcher and notification types on top of these exports.
