# Task 6 — Volume and workload reports

**Date:** 2026-10-08

**What:** Added `GET /reports/volume-by-category`, `GET /reports/volume-by-organisation` and `GET /reports/rep-workload`, each with an `/export` CSV sibling, open to admin, legal manager and viewer. The volume reports count every case matching the shared filters per category and type, or per entity, business unit (may be missing) and department. Rep workload counts open cases per assigned rep with awaiting-acceptance (status Assigned) and overdue counts; unassigned cases get no row. All three sort by count descending, then name, then id.

**Why:** Managers need to see where cases come from and who is carrying the load. Reusing `reportBaseQuery` keeps the filters identical to the case list, and the name-then-id tie-breakers make the output and the CSV deterministic.
