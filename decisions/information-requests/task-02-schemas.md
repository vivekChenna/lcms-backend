# Task 2 — Information-request Zod schemas

**Date:** 2026-10-04

**What:** Created Zod schemas for the information-requests workflow. Defined request/response validators (`raiseInformationRequestBodySchema`, `respondInformationRequestBodySchema`, `reopenInformationRequestBodySchema`, `informationRequestIdParamsSchema`, `informationRequestResponseSchema`, `informationRequestListResponseSchema`), a constant array of status enums (`INFO_REQUEST_STATUSES: ['open', 'answered', 'superseded']`), and comprehensive unit tests validating required fields, optional fields, type coercion (ISO date strings to Date), and field constraints (non-empty strings, UUID format).

**Why:** The schemas establish the contract between HTTP clients and the routes built in Tasks 4–7 (raise, respond, reopen, list). Type-safe validation at the boundary layer (via Zod) prevents invalid data from reaching business logic, simplifies error handling, and provides IDE autocomplete for downstream consumers (routes, controllers). Test coverage ensures the validators behave as intended before routes depend on them.
