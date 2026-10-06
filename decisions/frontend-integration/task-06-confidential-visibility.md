# Task 6 — Confidential case visibility

**Date:** 2026-10-09

**What:** A confidential case (`isConfidential = true`) is hidden from viewers and from requesters who neither submitted it (`requesterId`) nor are the responder of an information request on it. Admin, legal manager and legal rep see every case. The rule lives in two places that must stay in step: the visibility block at the top of `applyCaseFilters` (list, count, search, export, dashboard, reports) and the new exported `canActorSeeCase` (single case), which `getCaseById` uses and therefore every case sub-resource that gates on it (comments, documents, document versions and downloads, information requests). A hidden case answers 404. `updateCase` also checks `canActorSeeCase` first, so a PATCH on a hidden case answers 404 rather than 403.

**Why:** Spec §5. Putting the rule in the two existing choke points means no other service repeats it. The 404-before-403 order in `updateCase` stops a PATCH from confirming that a hidden case exists. Behaviour change: a requester now always sees a case they submitted, even if it sits in another department; no existing test depended on the old behaviour. Notifications that reference a case are only ever sent to the submitter, the assigned rep, legal managers or the information-request responder, all of whom can see the case, so they need no extra filter.
