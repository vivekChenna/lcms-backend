# Task 7 — Dashboard changes

**Date:** 2026-10-09

**What:** A legal rep's dashboard is now organisation-wide like every other non-requester role; the per-rep scoping and `tileFiltersFor` are gone. `tiles` gains `assignedToMe` (the caller's open cases, 0 for roles that hold none) and `unassigned` (status Submitted), with matching `filters` (`assignedToMe` carries the caller id). `myAssignedCases` is now the rep's open (non-Closed) cases, oldest first, at most 20. Every panel item carries `assignedLegalRepName` (string or null) via one batched `loadUserNames` per panel.

**Why:** The frontend lawyer dashboard shows org-wide counts plus a personal tile, and GET /cases already does not restrict a rep, so unqualified tile filters replay to the same counts. Confidential visibility still applies because scope goes through `applyCaseFilters`.
