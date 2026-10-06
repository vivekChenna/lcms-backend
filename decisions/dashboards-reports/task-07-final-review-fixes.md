# Task 7 — Final review fixes

**Date:** 2026-10-08

**What:** A legal rep's dashboard tile filters now carry `assignedLegalRepId` (the rep's own id), and the manager panel `openCaseloadByRep` has an id tie-breaker in its ordering. A new test replays every tile filter of a legal rep through `GET /cases` and checks the counts match.

**Why:** The dashboard counts only a rep's own cases, but `GET /cases` does not limit a rep to their own cases, so the unqualified tile filters returned other reps' cases and the clickable tiles (UI-10/11) disagreed with the counts. Deferred as minor and accepted: unqualified SLA column names in the shared SLA conditions (safe while report queries have no join that adds a clashing column), `onTime` counting a late-closed case as on time (spec assumption 2), and a few extra test gaps.
