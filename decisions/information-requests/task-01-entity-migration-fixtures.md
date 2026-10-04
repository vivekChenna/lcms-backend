# Task 1 — InformationRequest entity, migration, and test fixtures

**Date:** 2026-10-04

**What:** Created the `InformationRequest` entity, migration, and test fixture helper to support the information-requests workflow (Phase 2, sub-project 2). Added `information_requests` table with fields for tracking clarifying questions raised by legal reps on cases, including status lifecycle (open → answered → superseded), requester/responder tracking, and optional response text and reopening chains.

**Why:** The information-requests workflow is a new feature allowing legal representatives to raise clarifying questions on cases and route them to designated responders. This task establishes the persistence layer (entity, migration, test helper) that subsequent tasks will build business logic on top of. The test fixture ensures later tasks can seed reproducible test data without reimplementing the table structure in each test.
