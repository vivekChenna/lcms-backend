# Task 3 — Placeholder case reference number generator

**Date:** 2026-10-04

**What:** Created `src/modules/cases/reference-number.ts` with `deriveCaseTypeCode()` and `generateReferenceNumber()` functions that produce reference numbers in the placeholder format `EntityCode-CaseTypeCode-SequenceID` (e.g., `AGC-NAJ-000123`). Derived case type code is a 3-letter uppercase code extracted from the case type name, stripping non-letters and padding to 3 characters; falls back to `GEN` if no letters are found. Sequence is zero-padded to 6 digits. Isolated here as one swappable function so the real scheme from Algihaz (VC-06/AU-01) can drop in without touching call sites.

**Why:** Provides the reference number generation logic consumed by `cases.service.ts`'s `submitCase()` (Task 9). Defined as standalone, testable logic independent of database concerns, following TDD with 6 passing tests. Placeholder format is documented in comments and test description pending the real specification from Algihaz; when the spec arrives, this single file can be updated without rippling changes through the codebase.
