# Task 5 — Auto-routing matcher

**Date:** 2026-10-04

**What:** Created `src/modules/cases/auto-routing.ts` with `matchesCriteria()` (pure predicate that checks whether a routing rule's `matchCriteria` JSON object matches a case's attributes, treating an absent or `undefined` key as a wildcard) and `evaluateAutoRouting()` (loads active `RoutingRule` rows ordered by `priorityOrder` ascending and returns the first one whose criteria match, or `null`). `CaseMatchAttrs` defines the fixed shape of case attributes a rule can be matched against: `categoryId`, `caseTypeId`, `entityId`, `businessUnitId` (nullable), `departmentId`, `priority`.

**Why:** `submitCase` (Task 9) needs to auto-assign a legal rep to a newly submitted case without hardcoding routing logic. Splitting the matcher into a pure function (`matchesCriteria`) and a DB-touching evaluator (`evaluateAutoRouting`) keeps the matching rules unit-testable without a database while still covering the ordering/filtering behavior (lowest `priorityOrder` wins among active rules; inactive rules are ignored) with an integration test against the real `routing_rules` table. Wildcard-by-omission lets an admin write a rule that only constrains the fields it cares about (e.g. just `categoryId`) rather than enumerating every attribute.
