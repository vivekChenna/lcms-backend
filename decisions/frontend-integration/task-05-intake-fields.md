# Task 5 — Optional intake fields and confidential flag on cases

**Date:** 2026-10-09

**What:** Migration 1700000014000 adds `isConfidential` (boolean, not null, default false) and nullable `contactName`, `contactEmail`, `contactPhone`, `desiredOutcome`, `incidentDate`, `businessDeadline`, `counterparty`, `estimatedValue` (numeric 14,2) and `thirdPartyDetails` to `cases`. `POST /cases` and `PATCH /cases/:id` (while Submitted) accept them and every case response returns them. On create, empty or whitespace-only strings count as absent; on PATCH, `null` clears a field. The `case.updated` audit entry records all intake fields before and after. `seedCase` accepts the same names as overrides.

**Why:** The frontend intake form collects these fields. `estimatedValue` is converted to a number by an entity transformer (pg returns numeric as string), and date columns stay `YYYY-MM-DD` strings. The PATCH schema uses plain nullable strings rather than the blank-to-absent preprocessing, so a PATCH never silently ignores a blank and `null` is the explicit way to clear.
