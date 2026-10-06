# Task 3 — Name lookup module and names on case responses

**Date:** 2026-10-09

**What:** Added `src/shared/name-lookup.ts` (`loadUserNames`, `loadNamesById`, `loadCaseReferences`) and `src/modules/cases/case-names.ts` (`withCaseNames`). Every case response (list, detail, create, update, assign, accept, reject, close, escalate, priority) and the case CSV export now carry `requesterName`, `requesterDesignation`, `assignedLegalRepName`, `assignedLegalRepRole`, `categoryName`, `caseTypeName`, `departmentName`, `entityName` and `businessUnitName`. The CSV gains the matching name columns after the id columns.

**Why:** The frontend should show names, not ids, without extra calls per row. Lookups are batched, one query per kind of id per response, so a list of 100 cases costs six queries, not hundreds. Ids that do not resolve are absent from the lookup maps and the response field is null, so a missing row never fails a request. The name fields are `string | null` in the response schema.
