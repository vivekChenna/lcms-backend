# Task 3 — Case lifecycle notification event helpers

**Date:** 2026-10-06

**What:** Added `notifications.events.ts` with `toSingleLine`, `activeLegalManagerIds`, an exported `createNotifications` (dedupes recipients, skips missing or inactive users), and `notifyCaseRegistered/Assigned/Accepted/AssignmentRejected/Closed/SlaBreached`. Helpers accept a `DataSource` or `EntityManager` so callers can write inside their own transaction.

**Why:** Services need one place that decides who is told what for each case event. Titles double as email subjects, so they are collapsed to a single line and capped at 200 characters to prevent header injection; bodies carry the case title but never the description. Recipients are deduplicated (first draft wins) so a requester who is also the assignee gets one notification, and inactive users are skipped silently.
