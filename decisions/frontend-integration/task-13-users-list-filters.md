# Task 13 — Role, active and search filters on `GET /users`

**Date:** 2026-10-10

**What:** `GET /users` accepts `role` (one of the role names), `isActive` (`true` or `false`) and `search` (trimmed, non-empty) next to `page` and `pageSize`. `search` matches `fullName` or `email` case-insensitively with a parameterised `ILIKE`, and `%`, `_` and `\` in the text are escaped so they match literally. The filters apply to the same query that counts, so `total` reflects them. Access is unchanged (`admin` and `legal_manager`).

**Why:** The reassign dropdown needs the active legal reps. Without filters the frontend would have to page through every user and filter in the browser. The filters join `user_roles` and `roles` once, exactly as the list already did, so there is no extra query per row. The old unfiltered `repo.count()` was replaced by a `getCount()` on the filtered builder.
