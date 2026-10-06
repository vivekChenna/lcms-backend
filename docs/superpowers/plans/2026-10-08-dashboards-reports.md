# Dashboards, Reports & CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the role-scoped dashboard (DR-01..05), the five management reports (DR-06), and CSV export of reports, the case repository and the audit log (DR-07, PR-34, AT-04).

**Architecture:** A new `src/modules/dashboards-reports/` module holds the dashboard and report queries (QueryBuilder aggregates over `cases` joined to master data). The case filter logic is extracted from `listCases` into one exported `applyCaseFilters` that the list, the export, the dashboard and the reports all share, so counts can never drift. A small `csv.ts` builds sanitised UTF-8 CSV; every exportable view gets an `/export` sibling route.

**Tech Stack:** Fastify 5, TypeORM (QueryBuilder), PostgreSQL, Zod 4 + fastify-type-provider-zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-dashboards-reports-design.md`

## Global Constraints

- **Commit messages must NOT contain a `Co-Authored-By` trailer or any Claude/Anthropic attribution line.** The project owner has asked for this repeatedly. Write commit messages as plain text exactly as shown in each task's commit step.
- Work on `main`, one commit per task (code + tests + decision files together). Do not push. Never stage `.archify/`, `CLAUDE.md`, `Algihaz-LCMS-Database-Schema.docx`, `Timesheet_Sep-Oct_Algihaz_Vivek.xlsx`.
- No schema change and no migration. Do not add indexes unless a test or `EXPLAIN` shows a need; if you do, record it as a ruling in your report.
- Definitions (spec §2): *open* = status in Submitted, Assigned, In Progress, Waiting on Input (i.e. not Closed); *awaiting acceptance* = status Assigned; *overdue* = open and `resolutionDueAt < now()` (strict, database clock `now()`, never the Node clock); *on time* = total − overdue. A case closed late is NOT overdue.
- Dashboard scope: requester = cases they can already see (same department, or responder on an information request — exactly the `GET /cases` rule); legal_rep = cases where `assignedLegalRepId` is the caller; legal_manager, admin, viewer = all cases.
- Reports (all five, JSON and export) are for roles `admin`, `legal_manager`, `viewer` only; any other role gets 403. `GET /audit/export` is `admin` and `legal_manager` only. `GET /cases/export` is available to every authenticated role with exactly the same visibility as `GET /cases`.
- CSV: UTF-8 with BOM (`﻿` first), CRLF line endings, RFC 4180 quoting (quote a cell containing `"`, `,`, CR or LF; double embedded quotes). A **string** cell whose first character is `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` (numbers are never prefixed, so negative numbers stay numeric). `Date` → ISO 8601; `null`/`undefined` → empty; objects → compact JSON. Headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<name>-<YYYYMMDD>.csv"`, `X-Export-Total: <n>`, `X-Export-Truncated: true|false`.
- Export row cap: `DEFAULT_EXPORT_ROW_CAP = 10_000`, enforced in the query (`LIMIT`) for case and audit exports; aggregate report exports slice the (small) aggregated rows. The cap is injectable through `buildApp`'s `exportRowCap` option so tests can lower it.
- Exports and reads write no audit entries.
- Use the alias `c` for `cases` in QueryBuilder — never `case` (reserved word). Use QueryBuilder; the only raw SQL allowed is expression fragments inside `select`/`where` strings (e.g. `COUNT(*) FILTER (WHERE …)`, `now()`), as the existing case list already does.
- Test files use `resetDatabase(ds)` per test and seed fixture users/cases per test (never in `beforeAll`). Every integration file's `afterAll` calls `ds.undoLastMigration()` (existing pattern; copy it from any existing integration test).
- Any route returning `Date` through a Zod `z.string()` schema must convert at the route boundary (`.toISOString()`).
- TDD: write the failing test first, run it, see it fail, then implement.
- Run `npx tsc --noEmit` at the end of every task. Redirect long test output to a file and grep it; never `tail` it.

## Review Focus

- Counts must agree between a dashboard tile, the status chart, a `GET /cases` replay of the tile's filter, and the case CSV for the same role. Pinned in Tasks 1 and 4.
- A requester must never see counts or export rows for cases outside their scope. Pinned in Tasks 3 and 4.
- CSV cells beginning `=`, `+`, `-`, `@` must never reach a spreadsheet as a formula; Arabic text and embedded newlines must round-trip. Pinned in Tasks 2 and 3.
- The export cap must be applied in the query, and a truncated export must say so in headers. Pinned in Task 3.
- A case closed late must not count as overdue; an open case whose due time has just passed must; an open case due in the future must not. Pinned in Task 4.
- A role that may not see reports must get 403 on both the JSON and the export route. Pinned in Tasks 5 and 6.

---

### Task 1: Shared case filters and the `open` filter

**Files:**
- Modify: `src/modules/cases/cases.service.ts` (extract `applyCaseFilters`, add `open`, export `SLA_STATE_CONDITIONS`)
- Modify: `src/modules/cases/cases.schemas.ts` (add `open` to `caseListQuerySchema`)
- Test: `test/integration/modules/cases/list-open-filter.test.ts`

**Interfaces:**
- Produces:
  - `type CaseFilterQuery = { status?: string; priority?: string; categoryId?: string; caseTypeId?: string; entityId?: string; businessUnitId?: string; departmentId?: string; assignedLegalRepId?: string; search?: string; slaState?: 'on_track' | 'at_risk' | 'breached' | 'met'; open?: boolean }`
  - `type CaseListQuery = PaginationQuery & CaseFilterQuery` (replaces the current declaration)
  - `function applyCaseFilters(qb: SelectQueryBuilder<Case>, actor: Actor, query: CaseFilterQuery): void` — adds the requester scope for role `requester`, every filter, and `open`; alias must be `c`
  - `export const SLA_STATE_CONDITIONS` (currently module-private)
  - `GET /cases?open=true` → only cases with status ≠ Closed; omitting `open` changes nothing.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/cases/list-open-filter.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('GET /cases open filter', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  async function seedMix() {
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const repId = await seedUserWithRole(ds, 'legal_rep');
    for (const status of ['Submitted', 'Assigned', 'In Progress', 'Waiting on Input', 'Closed'] as const) {
      await seedCase(ds, { ...master, requesterId, status, assignedLegalRepId: status === 'Submitted' ? null : repId });
    }
    return { managerId };
  }

  it('open=true returns every case that is not Closed', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();

    const res = await app.inject({ method: 'GET', url: '/cases?open=true&pageSize=100', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(4);
    expect(res.json().items.map((item: { status: string }) => item.status)).not.toContain('Closed');
    await app.close();
  });

  it('omitting open still returns every case', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();

    const res = await app.inject({ method: 'GET', url: '/cases?pageSize=100', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.json().total).toBe(5);
    await app.close();
  });

  it('open combines with other filters and with the requester scope', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();
    const otherMaster = await seedCaseMasterData(ds);
    const otherRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedCase(ds, { ...otherMaster, requesterId: otherRequesterId, status: 'Submitted' });

    const combined = await app.inject({ method: 'GET', url: '/cases?open=true&status=Assigned', headers: authHeader(app, managerId, 'legal_manager') });
    const scoped = await app.inject({ method: 'GET', url: '/cases?open=true', headers: authHeader(app, otherRequesterId, 'requester') });

    expect(combined.json().total).toBe(1);
    expect(scoped.json().total).toBe(1);
    await app.close();
  });

  it('rejects an invalid open value with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { managerId } = await seedMix();

    const res = await app.inject({ method: 'GET', url: '/cases?open=maybe', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/cases/list-open-filter.test.ts`
Expected: FAIL — `open=true` is ignored (total 5 instead of 4), and `open=maybe` returns 200.

- [ ] **Step 3: Implement**

In `src/modules/cases/cases.schemas.ts` add to `caseListQuerySchema` (after `slaState`):

```typescript
  open: z.literal('true').transform(() => true).optional(),
```

In `src/modules/cases/cases.service.ts`:

1. Add `SelectQueryBuilder` to the existing `typeorm` import.
2. Replace the existing `CaseListQuery` declaration and `SLA_STATE_CONDITIONS` constant with:

```typescript
export type CaseFilterQuery = {
  status?: string;
  priority?: string;
  categoryId?: string;
  caseTypeId?: string;
  entityId?: string;
  businessUnitId?: string;
  departmentId?: string;
  assignedLegalRepId?: string;
  search?: string;
  slaState?: 'on_track' | 'at_risk' | 'breached' | 'met';
  open?: boolean;
};

export type CaseListQuery = PaginationQuery & CaseFilterQuery;

export const SLA_STATE_CONDITIONS: Record<string, string> = {
  /* keep the four existing entries exactly as they are */
};
```

3. Add this function directly above `listCases`, moving the requester-scope block and all the `if (query.… ) qb.andWhere(...)` lines out of `listCases` **unchanged** (keep the long comment about the `c` alias with them), and appending the `open` condition:

```typescript
// Shared by the case list, the case export, the dashboard and the reports so a
// tile, a chart bar, a CSV row and a list row can never disagree. The query
// builder must use the alias "c".
export function applyCaseFilters(qb: SelectQueryBuilder<Case>, actor: Actor, query: CaseFilterQuery): void {
  if (actor.role === 'requester') {
    qb.andWhere(
      '(c."departmentId" = :actorDepartmentId OR EXISTS (SELECT 1 FROM information_requests ir WHERE ir."caseId" = c.id AND ir."responderId" = :actorId))',
      { actorDepartmentId: actor.departmentId, actorId: actor.id },
    );
  }
  // ... the existing status/priority/category/caseType/entity/businessUnit/department/assignee/search/slaState conditions, verbatim ...
  if (query.open) {
    qb.andWhere(`c."status" != 'Closed'`);
  }
}
```

4. `listCases` becomes: create the query builder with alias `c`, call `applyCaseFilters(qb, actor, query)`, then the existing `getCount`, ordering/paging and mapping lines — nothing else changes.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/cases && npx tsc --noEmit`
Expected: PASS (new file 4 tests plus every existing cases test unchanged), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/dashboards-reports/task-01-shared-case-filters.md` (format: `# Task 1 — <title>`, `**Date:** 2026-10-08`, `**What:**`, `**Why:**`). In `decisions.md` add a new section `## dashboards-reports (Phase 2, sub-project 6)` directly above `## sla-breach (Phase 2, sub-project 5)` with one bullet linking to it (edit the file without re-encoding it; it is UTF-8). Commit once:

```bash
git add src/modules/cases/cases.service.ts src/modules/cases/cases.schemas.ts test/integration/modules/cases/list-open-filter.test.ts decisions.md decisions/dashboards-reports/task-01-shared-case-filters.md
git commit -m "refactor: share case filters and add open filter to GET /cases"
```

---

### Task 2: CSV builder

**Files:**
- Create: `src/modules/dashboards-reports/csv.ts`
- Test: `test/unit/modules/dashboards-reports/csv.test.ts`

**Interfaces:**
- Produces:
  - `const DEFAULT_EXPORT_ROW_CAP = 10_000`
  - `type CsvColumn<T> = { header: string; value: (row: T) => unknown }`
  - `function toCsvCell(value: unknown): string`
  - `function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string` — BOM + header line + one CRLF-terminated line per row
  - `function sendCsv(reply: FastifyReply, name: string, csv: string, meta: { total: number; truncated: boolean }): FastifyReply`
  - `function sendCsvRows<T>(reply: FastifyReply, name: string, rows: T[], columns: CsvColumn<T>[], cap: number): FastifyReply` — slices `rows` to `cap`, sets `truncated = rows.length > cap`, `total = rows.length`
  - `function exportFilename(name: string, now?: Date): string` → `<name>-YYYYMMDD.csv` (UTC date)

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/modules/dashboards-reports/csv.test.ts
import { describe, it, expect } from 'vitest';
import { exportFilename, toCsv, toCsvCell, DEFAULT_EXPORT_ROW_CAP } from '../../../../src/modules/dashboards-reports/csv';

describe('toCsvCell', () => {
  it('renders null and undefined as empty', () => {
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(undefined)).toBe('');
  });

  it('renders dates as ISO 8601, numbers and booleans plainly', () => {
    expect(toCsvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toCsvCell(42)).toBe('42');
    expect(toCsvCell(-3.5)).toBe('-3.5');
    expect(toCsvCell(true)).toBe('true');
  });

  it('renders objects as compact JSON, quoted because of the commas and quotes', () => {
    expect(toCsvCell({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });

  it('quotes cells containing commas, quotes or line breaks and doubles embedded quotes', () => {
    expect(toCsvCell('a,b')).toBe('"a,b"');
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(toCsvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])('neutralises the formula-looking string %j', (input) => {
    const cell = toCsvCell(input);
    expect(cell.replace(/^"/, '')[0]).toBe("'");
  });

  it('prefixes a dangerous string that also needs quoting', () => {
    expect(toCsvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
  });

  it('never prefixes real numbers, so negative numbers stay numeric', () => {
    expect(toCsvCell(-1)).toBe('-1');
  });

  it('keeps Arabic text intact', () => {
    expect(toCsvCell('قضية عقد ٢٠٢٦')).toBe('قضية عقد ٢٠٢٦');
  });
});

describe('toCsv', () => {
  it('starts with a BOM, then the header, then CRLF-terminated rows', () => {
    const csv = toCsv([{ a: 'x', b: 1 }, { a: 'y,z', b: 2 }], [
      { header: 'A', value: (row) => row.a },
      { header: 'B', value: (row) => row.b },
    ]);
    expect(csv).toBe('﻿A,B\r\nx,1\r\n"y,z",2\r\n');
  });

  it('with no rows still emits the BOM and the header', () => {
    expect(toCsv([], [{ header: 'A', value: () => '' }])).toBe('﻿A\r\n');
  });

  it('sanitises header cells too', () => {
    expect(toCsv([], [{ header: 'Total, all', value: () => '' }])).toBe('﻿"Total, all"\r\n');
  });
});

describe('exportFilename and the default cap', () => {
  it('uses the UTC date', () => {
    expect(exportFilename('cases', new Date('2026-10-08T23:59:59.000Z'))).toBe('cases-20261008.csv');
  });

  it('defaults the cap to 10 000 rows', () => {
    expect(DEFAULT_EXPORT_ROW_CAP).toBe(10_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/modules/dashboards-reports/csv.test.ts`
Expected: FAIL — `Cannot find module '.../dashboards-reports/csv'`.

- [ ] **Step 3: Implement**

```typescript
// src/modules/dashboards-reports/csv.ts
import type { FastifyReply } from 'fastify';

export const DEFAULT_EXPORT_ROW_CAP = 10_000;

export type CsvColumn<T> = { header: string; value: (row: T) => unknown };

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

// A string cell that starts with one of these is a formula to Excel/Sheets;
// the leading apostrophe keeps it as text. Real numbers are never prefixed.
export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else if (typeof value === 'string') {
    text = FORMULA_TRIGGERS.has(value[0] ?? '') ? `'${value}` : value;
  } else {
    text = String(value);
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => toCsvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvCell(column.value(row))).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function exportFilename(name: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${name}-${date}.csv`;
}

export function sendCsv(reply: FastifyReply, name: string, csv: string, meta: { total: number; truncated: boolean }): FastifyReply {
  return reply
    .header('Content-Disposition', `attachment; filename="${exportFilename(name)}"`)
    .header('X-Export-Total', String(meta.total))
    .header('X-Export-Truncated', String(meta.truncated))
    .type('text/csv; charset=utf-8')
    .send(csv);
}

export function sendCsvRows<T>(
  reply: FastifyReply,
  name: string,
  rows: T[],
  columns: CsvColumn<T>[],
  cap: number,
): FastifyReply {
  const truncated = rows.length > cap;
  return sendCsv(reply, name, toCsv(truncated ? rows.slice(0, cap) : rows, columns), { total: rows.length, truncated });
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/unit/modules/dashboards-reports/csv.test.ts && npx tsc --noEmit`
Expected: PASS (all cases), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/dashboards-reports/task-02-csv-builder.md` and add one bullet to the top of the `## dashboards-reports` section in `decisions.md`.

```bash
git add src/modules/dashboards-reports/csv.ts test/unit/modules/dashboards-reports/csv.test.ts decisions.md decisions/dashboards-reports/task-02-csv-builder.md
git commit -m "feat: CSV builder with formula-injection protection"
```

---

### Task 3: Case repository and audit exports

**Files:**
- Modify: `src/app.ts` (`AppOptions.exportRowCap`, pass `{ exportRowCap }` when registering `casesRoutes` and `auditRoutes`)
- Modify: `test/integration/helpers/build-test-app.ts` (accept and forward `exportRowCap?: number`)
- Modify: `src/modules/cases/cases.service.ts` (add `listCasesForExport`)
- Create: `src/modules/cases/cases.export.ts` (case export columns)
- Modify: `src/modules/cases/cases.routes.ts` (plugin options; `GET /cases/export`)
- Modify: `src/modules/cases/cases.schemas.ts` (`caseExportQuerySchema`)
- Modify: `src/modules/audit/audit.routes.ts` (plugin options; `GET /audit/export`)
- Test: `test/integration/modules/cases/cases-export.test.ts`
- Test: `test/integration/modules/audit/audit-export.test.ts`

**Interfaces:**
- Consumes: `applyCaseFilters`, `CaseFilterQuery` (Task 1); `toCsv`, `sendCsv`, `CsvColumn`, `DEFAULT_EXPORT_ROW_CAP` (Task 2).
- Produces: `buildApp(ds, { storage, uploadConfig?, exportRowCap? })`; `buildTestApp(ds, { storage?, uploadConfig?, exportRowCap? })`; `listCasesForExport(dataSource, actor, query: CaseFilterQuery, limit: number): Promise<{ rows: ReturnType<typeof toCaseWithSla>[]; total: number }>`; `CASE_EXPORT_COLUMNS: CsvColumn<ReturnType<typeof toCaseWithSla>>[]`; `caseExportQuerySchema = caseListQuerySchema.omit({ page: true, pageSize: true })`; routes `GET /cases/export`, `GET /audit/export`. The route plugins now accept `(app, opts: { exportRowCap?: number } = {})`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/integration/modules/cases/cases-export.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('GET /cases/export', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').filter((line) => line.length > 0);

  it('returns a CSV download with BOM, header, one row per visible case and the export headers', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, referenceNumber: 'EXP-0001', title: 'First' });
    await seedCase(ds, { ...master, requesterId, referenceNumber: 'EXP-0002', title: 'Second' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="cases-\d{8}\.csv"$/);
    expect(res.headers['x-export-total']).toBe('2');
    expect(res.headers['x-export-truncated']).toBe('false');
    expect(res.body.startsWith('﻿')).toBe(true);
    const rows = lines(res.body);
    expect(rows[0]).toContain('referenceNumber');
    expect(rows[0]).toContain('slaState');
    expect(rows[0]).toContain('caseAgeHours');
    expect(rows).toHaveLength(3);
    expect(res.body).toContain('EXP-0001');
    expect(res.body).toContain('EXP-0002');
    await app.close();
  });

  it('never exports the case description', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, description: 'CONFIDENTIAL DESCRIPTION TEXT 1234567890' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.body).not.toContain('CONFIDENTIAL DESCRIPTION');
    await app.close();
  });

  it('applies the same filters as the list', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    await seedCase(ds, { ...master, requesterId, status: 'Closed' });

    const open = await app.inject({ method: 'GET', url: '/cases/export?open=true', headers: authHeader(app, managerId, 'legal_manager') });
    const closed = await app.inject({ method: 'GET', url: '/cases/export?status=Closed', headers: authHeader(app, managerId, 'legal_manager') });

    expect(lines(open.body)).toHaveLength(2);
    expect(lines(closed.body)).toHaveLength(2);
    expect(open.headers['x-export-total']).toBe('1');
    await app.close();
  });

  it('limits a requester to the cases they can see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const otherRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedCase(ds, { ...master, requesterId, referenceNumber: 'MINE-1' });
    await seedCase(ds, { ...otherMaster, requesterId: otherRequesterId, referenceNumber: 'THEIRS-1' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, requesterId, 'requester') });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('MINE-1');
    expect(res.body).not.toContain('THEIRS-1');
    expect(res.headers['x-export-total']).toBe('1');
    await app.close();
  });

  it('neutralises formula-looking titles and keeps Arabic text and newlines intact', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    await seedCase(ds, { ...master, requesterId, title: '=cmd|\' /C calc\'!A0' });
    await seedCase(ds, { ...master, requesterId, title: 'قضية عقد\nسطر ثان' });

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.body).toContain("'=cmd|");
    expect(res.body).not.toMatch(/,=cmd\|/);
    expect(res.body).toContain('"قضية عقد\nسطر ثان"');
    await app.close();
  });

  it('caps the rows in the query and reports the truncation', async () => {
    const app = buildTestApp(ds, { exportRowCap: 2 });
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    for (let i = 0; i < 3; i += 1) {
      await seedCase(ds, { ...master, requesterId });
    }

    const res = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(lines(res.body)).toHaveLength(3);
    expect(res.headers['x-export-total']).toBe('3');
    expect(res.headers['x-export-truncated']).toBe('true');
    await app.close();
  });

  it('lets a viewer export and requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const ok = await app.inject({ method: 'GET', url: '/cases/export', headers: authHeader(app, viewerId, 'viewer') });
    const anonymous = await app.inject({ method: 'GET', url: '/cases/export' });

    expect(ok.statusCode).toBe(200);
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });

  it('does not shadow GET /cases/:id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId });

    const res = await app.inject({ method: 'GET', url: `/cases/${caseRow.id}`, headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(caseRow.id);
    await app.close();
  });
});
```

```typescript
// test/integration/modules/audit/audit-export.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { authHeader } from '../../helpers/auth-header';

describe('GET /audit/export', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').filter((line) => line.length > 0);

  it('exports audit rows as CSV for an admin and a legal manager', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created', afterValue: { id: 'x', note: 'a,b' } });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.updated' });

    const asAdmin = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, adminId, 'admin') });
    const asManager = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, managerId, 'legal_manager') });

    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.headers['content-disposition']).toMatch(/^attachment; filename="audit-\d{8}\.csv"$/);
    expect(asAdmin.headers['x-export-total']).toBe('2');
    expect(lines(asAdmin.body)[0]).toContain('action');
    expect(lines(asAdmin.body)).toHaveLength(3);
    expect(asAdmin.body).toContain('user.created');
    expect(asManager.statusCode).toBe(200);
    await app.close();
  });

  it('applies the same filters as GET /audit', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    await logAuditEvent(ds, { actorId: adminId, action: 'user.created' });
    await logAuditEvent(ds, { actorId: adminId, action: 'user.updated' });

    const res = await app.inject({ method: 'GET', url: '/audit/export?action=user.updated', headers: authHeader(app, adminId, 'admin') });

    expect(lines(res.body)).toHaveLength(2);
    expect(res.body).toContain('user.updated');
    expect(res.body).not.toContain('user.created');
    await app.close();
  });

  it('forbids every other role', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    for (const role of ['legal_rep', 'requester', 'viewer'] as const) {
      const userId = await seedUserWithRole(ds, role);
      const res = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, userId, role) });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it('caps the rows and reports the truncation', async () => {
    const app = buildTestApp(ds, { exportRowCap: 2 });
    await app.ready();
    const adminId = await seedUserWithRole(ds, 'admin');
    for (let i = 0; i < 3; i += 1) {
      await logAuditEvent(ds, { actorId: adminId, action: `test.event.${i}` });
    }

    const res = await app.inject({ method: 'GET', url: '/audit/export', headers: authHeader(app, adminId, 'admin') });

    expect(lines(res.body)).toHaveLength(3);
    expect(res.headers['x-export-total']).toBe('3');
    expect(res.headers['x-export-truncated']).toBe('true');
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/integration/modules/cases/cases-export.test.ts test/integration/modules/audit/audit-export.test.ts`
Expected: FAIL — `GET /cases/export` is routed to `/cases/:id` and returns 400, and `/audit/export` returns 404.

- [ ] **Step 3: Implement**

`src/app.ts`: change `AppOptions` to `{ storage: ObjectStorage; uploadConfig?: UploadConfig; exportRowCap?: number }` and register `app.register(auditRoutes, { exportRowCap: options.exportRowCap })` and `app.register(casesRoutes, { exportRowCap: options.exportRowCap })`.

`test/integration/helpers/build-test-app.ts`: add `exportRowCap?: number` to the `options` type and pass `exportRowCap: options.exportRowCap` to `buildApp`.

`src/modules/cases/cases.schemas.ts`:

```typescript
export const caseExportQuerySchema = caseListQuerySchema.omit({ page: true, pageSize: true });
```

`src/modules/cases/cases.service.ts` (next to `listCases`):

```typescript
export async function listCasesForExport(
  dataSource: DataSource,
  actor: Actor,
  query: CaseFilterQuery,
  limit: number,
): Promise<{ rows: ReturnType<typeof toCaseWithSla>[]; total: number }> {
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');
  applyCaseFilters(qb, actor, query);
  const total = await qb.getCount();
  const rows = await qb.orderBy('c."createdAt"', 'DESC').addOrderBy('c."id"', 'DESC').limit(limit).getMany();
  return { rows: rows.map((row) => toCaseWithSla(row)), total };
}
```

`src/modules/cases/cases.export.ts`:

```typescript
import type { toCaseWithSla } from './sla';
import type { CsvColumn } from '../dashboards-reports/csv';

type ExportCase = ReturnType<typeof toCaseWithSla>;

// The description is deliberately not exported.
export const CASE_EXPORT_COLUMNS: CsvColumn<ExportCase>[] = [
  { header: 'referenceNumber', value: (c) => c.referenceNumber },
  { header: 'title', value: (c) => c.title },
  { header: 'status', value: (c) => c.status },
  { header: 'priority', value: (c) => c.priority },
  { header: 'categoryId', value: (c) => c.categoryId },
  { header: 'caseTypeId', value: (c) => c.caseTypeId },
  { header: 'entityId', value: (c) => c.entityId },
  { header: 'businessUnitId', value: (c) => c.businessUnitId },
  { header: 'departmentId', value: (c) => c.departmentId },
  { header: 'assignedLegalRepId', value: (c) => c.assignedLegalRepId },
  { header: 'requesterId', value: (c) => c.requesterId },
  { header: 'createdAt', value: (c) => c.createdAt },
  { header: 'ackDueAt', value: (c) => c.ackDueAt },
  { header: 'resolutionDueAt', value: (c) => c.resolutionDueAt },
  { header: 'closedAt', value: (c) => c.closedAt },
  { header: 'slaState', value: (c) => c.slaState },
  { header: 'caseAgeHours', value: (c) => c.caseAgeHours },
  { header: 'isEscalated', value: (c) => c.isEscalated },
];
```

`src/modules/cases/cases.routes.ts`: change the default export signature to `casesRoutes(app: FastifyInstance, opts: { exportRowCap?: number } = {})`, import `listCasesForExport`, `caseExportQuerySchema`, `CASE_EXPORT_COLUMNS`, `toCsv`, `sendCsv`, `DEFAULT_EXPORT_ROW_CAP`, and register **before** the `/cases/:id` route (static routes win in Fastify, but keeping the order explicit avoids doubt):

```typescript
  typedApp.get('/cases/export', {
    preHandler: [app.authenticate],
    schema: { tags: ['Cases'], security: [{ bearerAuth: [] }], querystring: caseExportQuerySchema },
  }, async (request, reply) => {
    const cap = opts.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP;
    const { rows, total } = await listCasesForExport(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }, request.query, cap);
    return sendCsv(reply, 'cases', toCsv(rows, CASE_EXPORT_COLUMNS), { total, truncated: total > rows.length });
  });
```

`src/modules/audit/audit.routes.ts`: change the signature to `auditRoutes(app: FastifyInstance, opts: { exportRowCap?: number } = {})`, import `AuditLog` columns helpers, `toCsv`, `sendCsv`, `DEFAULT_EXPORT_ROW_CAP`, `CsvColumn`, and add:

```typescript
  const AUDIT_EXPORT_COLUMNS: CsvColumn<AuditLog>[] = [
    { header: 'id', value: (row) => row.id },
    { header: 'caseId', value: (row) => row.caseId },
    { header: 'actorId', value: (row) => row.actorId },
    { header: 'action', value: (row) => row.action },
    { header: 'createdAt', value: (row) => row.createdAt },
    { header: 'beforeValue', value: (row) => row.beforeValue },
    { header: 'afterValue', value: (row) => row.afterValue },
  ];

  typedApp.get('/audit/export', {
    preHandler: [app.authenticate, requireRole(['admin', 'legal_manager'])],
    schema: { tags: ['Audit'], security: [{ bearerAuth: [] }], querystring: auditQuerySchema.omit({ page: true, pageSize: true }) },
  }, async (request, reply) => {
    const cap = opts.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP;
    const query = request.query;
    const where: Record<string, unknown> = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.caseId) where.caseId = query.caseId;
    const repo = app.dataSource.getRepository(AuditLog);
    const total = await repo.count({ where });
    const rows = await repo.find({ where, order: { createdAt: 'DESC', id: 'DESC' }, take: cap });
    return sendCsv(reply, 'audit', toCsv(rows, AUDIT_EXPORT_COLUMNS), { total, truncated: total > rows.length });
  });
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/cases test/integration/modules/audit && npx tsc --noEmit`
Expected: PASS (new files plus every existing cases and audit test), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/dashboards-reports/task-03-case-and-audit-export.md` and add one bullet to the top of the `## dashboards-reports` section in `decisions.md`.

```bash
git add src/app.ts test/integration/helpers/build-test-app.ts src/modules/cases src/modules/audit/audit.routes.ts test/integration/modules/cases/cases-export.test.ts test/integration/modules/audit/audit-export.test.ts decisions.md decisions/dashboards-reports/task-03-case-and-audit-export.md
git commit -m "feat: CSV export for the case repository and the audit log"
```

---

### Task 4: Dashboard

**Files:**
- Create: `src/modules/dashboards-reports/dashboard.service.ts`
- Create: `src/modules/dashboards-reports/dashboard.schemas.ts`
- Create: `src/modules/dashboards-reports/dashboard.routes.ts`
- Modify: `src/app.ts` (register `dashboardRoutes`)
- Create: `test/integration/helpers/seed-case-times.ts`
- Test: `test/integration/modules/dashboards-reports/dashboard.test.ts`

**Interfaces:**
- Consumes: `applyCaseFilters`, `Actor` (Task 1 / existing), `toCaseWithSla`, `serializeCase`-style Date→ISO conversion.
- Produces:
  - `seedCaseWithTimes(ds, overrides: Parameters<typeof seedCase>[1] & { createdAt?: Date; resolutionDueAt?: Date; closedAt?: Date | null }): Promise<Case>` (reused by Tasks 5 and 6)
  - `getDashboard(dataSource, actor): Promise<DashboardResult>` where the result matches `dashboardResponseSchema` (below, Dates already ISO strings)
  - `GET /dashboard` (any authenticated role)

Response shape (exact):

```
{
  tiles: { total, open, awaitingAcceptance, waitingOnInput, overdue, onTime, closed },
  filters: { total: {}, open: { open: 'true' }, awaitingAcceptance: { status: 'Assigned' },
             waitingOnInput: { status: 'Waiting on Input' },
             overdue: { open: 'true', slaState: 'breached' }, closed: { status: 'Closed' } },
  byStatus: [{ status, count }]   // all five statuses in order Submitted, Assigned, In Progress, Waiting on Input, Closed
  myAssignedCases?: PanelItem[]   // legal_rep only
  managerPanels?: {               // legal_manager and admin only
    openCaseloadByRep: [{ legalRepId, fullName, openCount, overdueCount }],
    unassigned: { count, items: PanelItem[] },
    awaitingAcceptance: { count, items: PanelItem[] }
  }
}
PanelItem = { id, referenceNumber, title, priority, status, resolutionDueAt (ISO), slaState }
```

`filters` values are strings (the exact query string a client would send to `GET /cases`); `onTime` has no filter. Panels hold at most 20 items, oldest first (`createdAt` ASC).

- [ ] **Step 1: Write the fixture and the failing test**

```typescript
// test/integration/helpers/seed-case-times.ts
import type { DataSource } from 'typeorm';
import { Case } from '../../../src/modules/cases/entities/case.entity';
import { seedCase } from './seed-case';

// seedCase cannot set createdAt / resolutionDueAt / closedAt directly; reports and
// the dashboard need cases at precise ages and due times.
export async function seedCaseWithTimes(
  ds: DataSource,
  overrides: Parameters<typeof seedCase>[1] & { createdAt?: Date; resolutionDueAt?: Date; closedAt?: Date | null },
): Promise<Case> {
  const { createdAt, resolutionDueAt, closedAt, ...rest } = overrides;
  const row = await seedCase(ds, rest);
  if (createdAt) {
    await ds.query(`UPDATE cases SET "createdAt" = $1 WHERE id = $2`, [createdAt, row.id]);
  }
  if (resolutionDueAt) {
    await ds.query(`UPDATE cases SET "resolutionDueAt" = $1 WHERE id = $2`, [resolutionDueAt, row.id]);
  }
  if (closedAt !== undefined) {
    await ds.query(`UPDATE cases SET "closedAt" = $1 WHERE id = $2`, [closedAt, row.id]);
  }
  return ds.getRepository(Case).findOneByOrFail({ id: row.id });
}
```

```typescript
// test/integration/modules/dashboards-reports/dashboard.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithTimes } from '../../helpers/seed-case-times';
import { authHeader } from '../../helpers/auth-header';

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

describe('GET /dashboard', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  // Six cases: A Submitted (future due), B Assigned to rep (future), C In Progress rep OVERDUE,
  // D Waiting on Input other rep (future), E Closed on time, F Closed LATE (due in the past).
  async function seedWorld() {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const base = { ...master, requesterId };
    const a = await seedCaseWithTimes(ds, { ...base, status: 'Submitted', resolutionDueAt: inHours(48), createdAt: inHours(-5) });
    const b = await seedCaseWithTimes(ds, { ...base, status: 'Assigned', assignedLegalRepId: repId, resolutionDueAt: inHours(48), createdAt: inHours(-4) });
    const c = await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: repId, resolutionDueAt: inHours(-1), createdAt: inHours(-100) });
    const d = await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', assignedLegalRepId: otherRepId, resolutionDueAt: inHours(48), createdAt: inHours(-3) });
    const e = await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: repId, resolutionDueAt: inHours(10), closedAt: inHours(-2), createdAt: inHours(-50) });
    const f = await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: repId, resolutionDueAt: inHours(-20), closedAt: inHours(-2), createdAt: inHours(-60) });
    return { master, repId, otherRepId, requesterId, a, b, c, d, e, f };
  }

  it('gives a legal manager every tile, all five statuses and both manager panels', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const world = await seedWorld();
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tiles).toEqual({ total: 6, open: 4, awaitingAcceptance: 1, waitingOnInput: 1, overdue: 1, onTime: 5, closed: 2 });
    expect(body.byStatus).toEqual([
      { status: 'Submitted', count: 1 },
      { status: 'Assigned', count: 1 },
      { status: 'In Progress', count: 1 },
      { status: 'Waiting on Input', count: 1 },
      { status: 'Closed', count: 2 },
    ]);
    expect(body.filters.overdue).toEqual({ open: 'true', slaState: 'breached' });
    expect(body.filters.onTime).toBeUndefined();
    expect(body).not.toHaveProperty('myAssignedCases');
    const panels = body.managerPanels;
    expect(panels.unassigned.count).toBe(1);
    expect(panels.unassigned.items.map((item: { id: string }) => item.id)).toEqual([world.a.id]);
    expect(panels.awaitingAcceptance.count).toBe(1);
    expect(panels.awaitingAcceptance.items[0]).toMatchObject({ id: world.b.id, status: 'Assigned', priority: 'P3' });
    expect(typeof panels.awaitingAcceptance.items[0].resolutionDueAt).toBe('string');
    expect(panels.openCaseloadByRep).toEqual([
      { legalRepId: world.repId, fullName: expect.any(String), openCount: 2, overdueCount: 1 },
      { legalRepId: world.otherRepId, fullName: expect.any(String), openCount: 1, overdueCount: 0 },
    ]);
    await app.close();
  });

  it('does not count a case closed late as overdue, nor an open case due in the future', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    await seedCaseWithTimes(ds, { ...master, requesterId, status: 'Closed', resolutionDueAt: inHours(-20), closedAt: inHours(-2) });
    await seedCaseWithTimes(ds, { ...master, requesterId, status: 'In Progress', resolutionDueAt: inHours(1) });
    await seedCaseWithTimes(ds, { ...master, requesterId, status: 'In Progress', resolutionDueAt: new Date(Date.now() - 1000) });

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    expect(res.json().tiles.overdue).toBe(1);
    expect(res.json().tiles.onTime).toBe(2);
    await app.close();
  });

  it('returns all zeros and all five statuses when there are no cases', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    const body = res.json();
    expect(body.tiles).toEqual({ total: 0, open: 0, awaitingAcceptance: 0, waitingOnInput: 0, overdue: 0, onTime: 0, closed: 0 });
    expect(body.byStatus).toHaveLength(5);
    expect(body.byStatus.every((row: { count: number }) => row.count === 0)).toBe(true);
    expect(body.managerPanels.openCaseloadByRep).toEqual([]);
    await app.close();
  });

  it('scopes a legal rep to their own cases and adds myAssignedCases', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const world = await seedWorld();

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, world.repId, 'legal_rep') });

    const body = res.json();
    expect(body.tiles).toEqual({ total: 4, open: 2, awaitingAcceptance: 1, waitingOnInput: 0, overdue: 1, onTime: 3, closed: 2 });
    expect(body.myAssignedCases.map((item: { id: string }) => item.id)).toEqual([world.b.id]);
    expect(body).not.toHaveProperty('managerPanels');
    await app.close();
  });

  it('scopes a requester to the cases they can see', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const world = await seedWorld();
    const otherMaster = await seedCaseMasterData(ds);
    const otherRequesterId = await seedUserWithRole(ds, 'requester', { departmentId: otherMaster.departmentId, entityId: otherMaster.entityId });
    await seedCaseWithTimes(ds, { ...otherMaster, requesterId: otherRequesterId, status: 'Submitted' });

    const mine = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, world.requesterId, 'requester') });
    const theirs = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, otherRequesterId, 'requester') });

    expect(mine.json().tiles.total).toBe(6);
    expect(theirs.json().tiles.total).toBe(1);
    expect(mine.json()).not.toHaveProperty('managerPanels');
    expect(mine.json()).not.toHaveProperty('myAssignedCases');
    await app.close();
  });

  it('gives admin the manager panels and a viewer only tiles and the chart', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedWorld();
    const adminId = await seedUserWithRole(ds, 'admin');
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const admin = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, adminId, 'admin') });
    const viewer = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, viewerId, 'viewer') });

    expect(admin.json().managerPanels).toBeDefined();
    expect(viewer.json().tiles.total).toBe(6);
    expect(viewer.json()).not.toHaveProperty('managerPanels');
    expect(viewer.json()).not.toHaveProperty('myAssignedCases');
    await app.close();
  });

  it('every tile filter replays through GET /cases to the same count', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    await seedWorld();
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const headers = authHeader(app, managerId, 'legal_manager');
    const dashboard = (await app.inject({ method: 'GET', url: '/dashboard', headers })).json();

    for (const tile of ['total', 'open', 'awaitingAcceptance', 'waitingOnInput', 'overdue', 'closed'] as const) {
      const params = new URLSearchParams({ ...dashboard.filters[tile], pageSize: '100' });
      const list = await app.inject({ method: 'GET', url: `/cases?${params.toString()}`, headers });
      expect(list.json().total, tile).toBe(dashboard.tiles[tile]);
    }
    await app.close();
  });

  it('caps each panel at 20 items, oldest first, while the count stays exact', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    for (let i = 0; i < 22; i += 1) {
      await seedCaseWithTimes(ds, { ...master, requesterId, status: 'Submitted', createdAt: inHours(-(100 - i)), referenceNumber: `CAP-${String(i).padStart(2, '0')}` });
    }

    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: authHeader(app, managerId, 'legal_manager') });

    const unassigned = res.json().managerPanels.unassigned;
    expect(unassigned.count).toBe(22);
    expect(unassigned.items).toHaveLength(20);
    expect(unassigned.items[0].referenceNumber).toBe('CAP-00');
    await app.close();
  });

  it('requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/dashboard' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/dashboards-reports/dashboard.test.ts`
Expected: FAIL — `GET /dashboard` returns 404.

- [ ] **Step 3: Implement**

```typescript
// src/modules/dashboards-reports/dashboard.schemas.ts
import { z } from 'zod';
import { CASE_PRIORITIES, CASE_STATUSES, SLA_STATES } from '../cases/cases.schemas';

export const panelItemSchema = z.object({
  id: z.string(),
  referenceNumber: z.string(),
  title: z.string(),
  priority: z.enum(CASE_PRIORITIES),
  status: z.enum(CASE_STATUSES),
  resolutionDueAt: z.string(),
  slaState: z.enum(SLA_STATES),
});

const countSchema = z.number();

export const dashboardResponseSchema = z.object({
  tiles: z.object({
    total: countSchema,
    open: countSchema,
    awaitingAcceptance: countSchema,
    waitingOnInput: countSchema,
    overdue: countSchema,
    onTime: countSchema,
    closed: countSchema,
  }),
  filters: z.record(z.string(), z.record(z.string(), z.string())),
  byStatus: z.array(z.object({ status: z.enum(CASE_STATUSES), count: countSchema })),
  myAssignedCases: z.array(panelItemSchema).optional(),
  managerPanels: z
    .object({
      openCaseloadByRep: z.array(
        z.object({ legalRepId: z.string(), fullName: z.string(), openCount: countSchema, overdueCount: countSchema }),
      ),
      unassigned: z.object({ count: countSchema, items: z.array(panelItemSchema) }),
      awaitingAcceptance: z.object({ count: countSchema, items: z.array(panelItemSchema) }),
    })
    .optional(),
});

export type DashboardResult = z.infer<typeof dashboardResponseSchema>;
```

(`SLA_STATES`, `CASE_STATUSES`, `CASE_PRIORITIES` are exported from `cases.schemas.ts`.)

```typescript
// src/modules/dashboards-reports/dashboard.service.ts
import type { DataSource, SelectQueryBuilder } from 'typeorm';
import { Case, type CaseStatus } from '../cases/entities/case.entity';
import { User } from '../users/entities/user.entity';
import { applyCaseFilters, type Actor } from '../cases/cases.service';
import { toCaseWithSla } from '../cases/sla';
import type { DashboardResult } from './dashboard.schemas';

const STATUSES: CaseStatus[] = ['Submitted', 'Assigned', 'In Progress', 'Waiting on Input', 'Closed'];
const PANEL_LIMIT = 20;

const TILE_FILTERS: DashboardResult['filters'] = {
  total: {},
  open: { open: 'true' },
  awaitingAcceptance: { status: 'Assigned' },
  waitingOnInput: { status: 'Waiting on Input' },
  overdue: { open: 'true', slaState: 'breached' },
  closed: { status: 'Closed' },
};

// Requester scope comes from applyCaseFilters (the same rule as GET /cases);
// a legal rep is limited to their own cases; manager/admin/viewer see all.
function scopedQuery(dataSource: DataSource, actor: Actor): SelectQueryBuilder<Case> {
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');
  applyCaseFilters(qb, actor, {});
  if (actor.role === 'legal_rep') {
    qb.andWhere('c."assignedLegalRepId" = :repScopeId', { repScopeId: actor.id });
  }
  return qb;
}

async function panel(dataSource: DataSource, actor: Actor, status: CaseStatus, onlyAssignedToActor = false) {
  const base = () => {
    const qb = scopedQuery(dataSource, actor).andWhere('c."status" = :panelStatus', { panelStatus: status });
    if (onlyAssignedToActor) {
      qb.andWhere('c."assignedLegalRepId" = :panelActorId', { panelActorId: actor.id });
    }
    return qb;
  };
  const count = await base().getCount();
  const rows = await base().orderBy('c."createdAt"', 'ASC').addOrderBy('c."id"', 'ASC').limit(PANEL_LIMIT).getMany();
  const items = rows.map((row) => {
    const withSla = toCaseWithSla(row);
    return {
      id: withSla.id,
      referenceNumber: withSla.referenceNumber,
      title: withSla.title,
      priority: withSla.priority,
      status: withSla.status,
      resolutionDueAt: withSla.resolutionDueAt.toISOString(),
      slaState: withSla.slaState,
    };
  });
  return { count, items };
}

export async function getDashboard(dataSource: DataSource, actor: Actor): Promise<DashboardResult> {
  const tileRow = await scopedQuery(dataSource, actor)
    .select('COUNT(*)', 'total')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed')`, 'open')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Assigned')`, 'awaitingAcceptance')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Waiting on Input')`, 'waitingOnInput')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."resolutionDueAt" < now())`, 'overdue')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Closed')`, 'closed')
    .getRawOne<Record<string, string>>();
  const total = Number(tileRow?.total ?? 0);
  const overdue = Number(tileRow?.overdue ?? 0);

  const statusRows = await scopedQuery(dataSource, actor)
    .select('c."status"', 'status')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c."status"')
    .getRawMany<{ status: CaseStatus; count: string }>();
  const byStatus = STATUSES.map((status) => ({
    status,
    count: Number(statusRows.find((row) => row.status === status)?.count ?? 0),
  }));

  const result: DashboardResult = {
    tiles: {
      total,
      open: Number(tileRow?.open ?? 0),
      awaitingAcceptance: Number(tileRow?.awaitingAcceptance ?? 0),
      waitingOnInput: Number(tileRow?.waitingOnInput ?? 0),
      overdue,
      onTime: total - overdue,
      closed: Number(tileRow?.closed ?? 0),
    },
    filters: TILE_FILTERS,
    byStatus,
  };

  if (actor.role === 'legal_rep') {
    result.myAssignedCases = (await panel(dataSource, actor, 'Assigned', true)).items;
  }

  if (actor.role === 'legal_manager' || actor.role === 'admin') {
    const loadRows = await scopedQuery(dataSource, actor)
      .innerJoin(User, 'u', 'u.id = c."assignedLegalRepId"')
      .select('c."assignedLegalRepId"', 'legalRepId')
      .addSelect('u."fullName"', 'fullName')
      .addSelect('COUNT(*)', 'openCount')
      .addSelect('COUNT(*) FILTER (WHERE c."resolutionDueAt" < now())', 'overdueCount')
      .andWhere(`c."status" != 'Closed'`)
      .groupBy('c."assignedLegalRepId"')
      .addGroupBy('u."fullName"')
      .orderBy('COUNT(*)', 'DESC')
      .addOrderBy('u."fullName"', 'ASC')
      .getRawMany<{ legalRepId: string; fullName: string; openCount: string; overdueCount: string }>();
    result.managerPanels = {
      openCaseloadByRep: loadRows.map((row) => ({
        legalRepId: row.legalRepId,
        fullName: row.fullName,
        openCount: Number(row.openCount),
        overdueCount: Number(row.overdueCount),
      })),
      unassigned: await panel(dataSource, actor, 'Submitted'),
      awaitingAcceptance: await panel(dataSource, actor, 'Assigned'),
    };
  }

  return result;
}
```

```typescript
// src/modules/dashboards-reports/dashboard.routes.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getDashboard } from './dashboard.service';
import { dashboardResponseSchema } from './dashboard.schemas';

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/dashboard', {
    preHandler: [app.authenticate],
    schema: { tags: ['Dashboard'], security: [{ bearerAuth: [] }], response: { 200: dashboardResponseSchema } },
  }, async (request) =>
    getDashboard(app.dataSource, {
      id: request.user.id,
      role: request.user.role,
      departmentId: request.user.departmentId,
      entityId: request.user.entityId,
      businessUnitId: request.user.businessUnitId,
    }));
}
```

`src/app.ts`: import and `app.register(dashboardRoutes);` after `notificationsRoutes`.

Note the ties: when two reps have the same `openCount`, ordering falls back to `fullName`; the test's two reps have different counts (2 and 1), so it is deterministic.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/dashboards-reports/dashboard.test.ts && npx tsc --noEmit`
Expected: PASS (9 tests), `tsc` clean. If `ORDER BY COUNT(*)` or the `FILTER` aggregates are rejected by TypeORM's alias handling, find the smallest working form and keep every behaviour above identical; record the change in your report. Run the file twice to confirm it is stable.

- [ ] **Step 5: Commit**

Create `decisions/dashboards-reports/task-04-dashboard.md` and add one bullet to the top of the `## dashboards-reports` section in `decisions.md`.

```bash
git add src/modules/dashboards-reports/dashboard.service.ts src/modules/dashboards-reports/dashboard.schemas.ts src/modules/dashboards-reports/dashboard.routes.ts src/app.ts test/integration/helpers/seed-case-times.ts test/integration/modules/dashboards-reports/dashboard.test.ts decisions.md decisions/dashboards-reports/task-04-dashboard.md
git commit -m "feat: GET /dashboard with role-scoped tiles, chart data and panels"
```

---

### Task 5: Reports infrastructure, SLA compliance and ageing

**Files:**
- Create: `src/modules/dashboards-reports/reports.schemas.ts`
- Create: `src/modules/dashboards-reports/reports.service.ts`
- Create: `src/modules/dashboards-reports/reports.routes.ts`
- Modify: `src/app.ts` (register `reportsRoutes` with `{ exportRowCap }`)
- Test: `test/integration/modules/dashboards-reports/reports-sla-ageing.test.ts`

**Interfaces:**
- Consumes: `applyCaseFilters`, `SLA_STATE_CONDITIONS`, `Actor` (Task 1); `CsvColumn`, `sendCsvRows`, `DEFAULT_EXPORT_ROW_CAP` (Task 2); `seedCaseWithTimes` (Task 4); `buildTestApp` with `exportRowCap` (Task 3).
- Produces:
  - `reportQuerySchema` (query: optional `status`, `priority`, `categoryId`, `caseTypeId`, `entityId`, `businessUnitId`, `departmentId`, `assignedLegalRepId`, plus `createdFrom`, `createdTo` coerced dates; 400 when `createdFrom > createdTo`) and `type ReportQuery`
  - `reportBaseQuery(dataSource, actor, filters: ReportQuery): SelectQueryBuilder<Case>` (alias `c`; applies `applyCaseFilters` then `createdFrom` (>=) / `createdTo` (<=) on `c."createdAt"`)
  - `slaComplianceReport(dataSource, actor, filters): Promise<SlaComplianceRow>` with `{ closedOnTime, closedLate, openOnTrack, openAtRisk, openBreached, compliancePercent: number | null }` (`compliancePercent` = `closedOnTime / (closedOnTime + closedLate) * 100` rounded to one decimal, `null` when nothing closed)
  - `ageingReport(dataSource, actor, filters): Promise<{ bucket: '0-7' | '8-30' | '31-90' | '91+'; count: number }[]>` — all four buckets always, open cases only, by age in whole days since `createdAt`: 0–7 days → age < 8 days; 8–30 → ≥ 8 and < 31 days; 31–90 → ≥ 31 and < 91; 91+ → ≥ 91 days
  - Routes: `GET /reports/sla-compliance`, `GET /reports/sla-compliance/export`, `GET /reports/ageing`, `GET /reports/ageing/export` (roles `admin`, `legal_manager`, `viewer`)
  - `REPORT_ROLES = ['admin', 'legal_manager', 'viewer']`; `reportsRoutes(app, opts: { exportRowCap?: number } = {})` — Task 6 adds more routes inside this same plugin.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/dashboards-reports/reports-sla-ageing.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithTimes } from '../../helpers/seed-case-times';
import { authHeader } from '../../helpers/auth-header';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

describe('SLA compliance and ageing reports', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  async function parties() {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    return { master, requesterId, managerId };
  }

  describe('GET /reports/sla-compliance', () => {
    it('counts closed on time / late and open on track / at risk / breached', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId, managerId } = await parties();
      const base = { ...master, requesterId };
      // closed on time x2, closed late x1
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(10), resolutionDueAt: inHours(-24), closedAt: inHours(-48) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(10), resolutionDueAt: inHours(-24), closedAt: inHours(-24) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(10), resolutionDueAt: inHours(-48), closedAt: inHours(-24) });
      // open: on track (far future), at risk (due in 1h of a 100h window), breached (past)
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: inHours(-10), resolutionDueAt: inHours(90) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: inHours(-99), resolutionDueAt: inHours(1) });
      await seedCaseWithTimes(ds, { ...base, status: 'Submitted', createdAt: inHours(-50), resolutionDueAt: inHours(-1) });

      const res = await app.inject({ method: 'GET', url: '/reports/sla-compliance', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        closedOnTime: 2,
        closedLate: 1,
        openOnTrack: 1,
        openAtRisk: 1,
        openBreached: 1,
        compliancePercent: 66.7,
      });
      await app.close();
    });

    it('returns zeros and a null percentage when nothing is closed', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await parties();

      const res = await app.inject({ method: 'GET', url: '/reports/sla-compliance', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.json()).toEqual({ closedOnTime: 0, closedLate: 0, openOnTrack: 0, openAtRisk: 0, openBreached: 0, compliancePercent: null });
      await app.close();
    });

    it('narrows by date range and by case filters', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId, managerId } = await parties();
      const otherMaster = await seedCaseMasterData(ds);
      const base = { ...master, requesterId };
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: new Date('2026-01-10T00:00:00Z'), resolutionDueAt: new Date('2026-01-20T00:00:00Z'), closedAt: new Date('2026-01-15T00:00:00Z') });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: new Date('2026-03-10T00:00:00Z'), resolutionDueAt: new Date('2026-03-12T00:00:00Z'), closedAt: new Date('2026-03-15T00:00:00Z') });
      await seedCaseWithTimes(ds, { ...otherMaster, requesterId, status: 'Closed', createdAt: new Date('2026-01-11T00:00:00Z'), resolutionDueAt: new Date('2026-01-20T00:00:00Z'), closedAt: new Date('2026-01-15T00:00:00Z') });
      const headers = authHeader(app, managerId, 'legal_manager');

      const january = await app.inject({ method: 'GET', url: '/reports/sla-compliance?createdFrom=2026-01-01T00:00:00Z&createdTo=2026-02-01T00:00:00Z', headers });
      const january1 = await app.inject({ method: 'GET', url: `/reports/sla-compliance?createdFrom=2026-01-01T00:00:00Z&createdTo=2026-02-01T00:00:00Z&categoryId=${master.categoryId}`, headers });

      expect(january.json().closedOnTime).toBe(2);
      expect(january1.json().closedOnTime).toBe(1);
      await app.close();
    });

    it('rejects createdFrom after createdTo and invalid values with 400', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await parties();
      const headers = authHeader(app, managerId, 'legal_manager');

      const reversed = await app.inject({ method: 'GET', url: '/reports/sla-compliance?createdFrom=2026-03-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z', headers });
      const garbage = await app.inject({ method: 'GET', url: '/reports/sla-compliance?createdFrom=yesterday-ish', headers });
      const badUuid = await app.inject({ method: 'GET', url: '/reports/sla-compliance?categoryId=nope', headers });

      expect(reversed.statusCode).toBe(400);
      expect(garbage.statusCode).toBe(400);
      expect(badUuid.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('GET /reports/ageing', () => {
    it('buckets open cases by age and ignores closed ones, with all four buckets always present', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId, managerId } = await parties();
      const base = { ...master, requesterId, resolutionDueAt: inHours(500) };
      // age boundaries: 7d23h -> 0-7, 8d -> 8-30, 30d23h -> 8-30, 31d -> 31-90, 90d23h -> 31-90, 91d -> 91+
      await seedCaseWithTimes(ds, { ...base, status: 'Submitted', createdAt: new Date(Date.now() - (8 * DAY - HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Assigned', createdAt: new Date(Date.now() - (8 * DAY + HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: new Date(Date.now() - (31 * DAY - HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', createdAt: new Date(Date.now() - (31 * DAY + HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', createdAt: new Date(Date.now() - (91 * DAY - HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', createdAt: new Date(Date.now() - (91 * DAY + HOUR)) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', createdAt: daysAgo(200), closedAt: daysAgo(1) });

      const res = await app.inject({ method: 'GET', url: '/reports/ageing', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { bucket: '0-7', count: 1 },
        { bucket: '8-30', count: 1 },
        { bucket: '31-90', count: 2 },
        { bucket: '91+', count: 2 },
      ]);
      await app.close();
    });

    it('returns four zero buckets when there are no open cases', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await parties();

      const res = await app.inject({ method: 'GET', url: '/reports/ageing', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.json()).toEqual([
        { bucket: '0-7', count: 0 },
        { bucket: '8-30', count: 0 },
        { bucket: '31-90', count: 0 },
        { bucket: '91+', count: 0 },
      ]);
      await app.close();
    });
  });

  describe('access and export', () => {
    it('allows admin, legal manager and viewer and forbids legal rep and requester on the JSON and export routes', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      for (const url of ['/reports/sla-compliance', '/reports/sla-compliance/export', '/reports/ageing', '/reports/ageing/export']) {
        for (const role of ['admin', 'legal_manager', 'viewer'] as const) {
          const userId = await seedUserWithRole(ds, role);
          const res = await app.inject({ method: 'GET', url, headers: authHeader(app, userId, role) });
          expect(res.statusCode, `${role} ${url}`).toBe(200);
        }
        for (const role of ['legal_rep', 'requester'] as const) {
          const userId = await seedUserWithRole(ds, role);
          const res = await app.inject({ method: 'GET', url, headers: authHeader(app, userId, role) });
          expect(res.statusCode, `${role} ${url}`).toBe(403);
        }
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      }
      await app.close();
    });

    it('exports the SLA compliance report as a one-row CSV and the ageing report as four rows', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { master, requesterId } = await parties();
      const viewerId = await seedUserWithRole(ds, 'viewer');
      await seedCaseWithTimes(ds, { ...master, requesterId, status: 'Closed', createdAt: daysAgo(5), resolutionDueAt: inHours(-24), closedAt: inHours(-48) });
      const headers = authHeader(app, viewerId, 'viewer');

      const sla = await app.inject({ method: 'GET', url: '/reports/sla-compliance/export', headers });
      const ageing = await app.inject({ method: 'GET', url: '/reports/ageing/export', headers });

      const slaLines = sla.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(sla.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(sla.headers['content-disposition']).toMatch(/^attachment; filename="sla-compliance-\d{8}\.csv"$/);
      expect(sla.body.startsWith('﻿')).toBe(true);
      expect(slaLines[0]).toBe('closedOnTime,closedLate,openOnTrack,openAtRisk,openBreached,compliancePercent');
      expect(slaLines[1]).toBe('1,0,0,0,0,100');
      const ageingLines = ageing.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(ageingLines).toEqual(['bucket,count', '0-7,0', '8-30,0', '31-90,0', '91+,0']);
      await app.close();
    });
  });
});
```

Test note: the at-risk case (created 99h ago, due in 1h) is within 20 % of its 100h window; the on-track case (created 10h ago, due in 90h) has 90 % remaining; the breached case is past due. If the existing at-risk rule makes a different assertion correct, fix the test data, not the rule.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/dashboards-reports/reports-sla-ageing.test.ts`
Expected: FAIL — every `/reports/...` request returns 404.

- [ ] **Step 3: Implement**

```typescript
// src/modules/dashboards-reports/reports.schemas.ts
import { z } from 'zod';
import { CASE_PRIORITIES, CASE_STATUSES } from '../cases/cases.schemas';

export const reportQuerySchema = z
  .object({
    status: z.enum(CASE_STATUSES).optional(),
    priority: z.enum(CASE_PRIORITIES).optional(),
    categoryId: z.string().uuid().optional(),
    caseTypeId: z.string().uuid().optional(),
    entityId: z.string().uuid().optional(),
    businessUnitId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    assignedLegalRepId: z.string().uuid().optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
  })
  .refine((query) => !query.createdFrom || !query.createdTo || query.createdFrom <= query.createdTo, {
    message: 'createdFrom must not be after createdTo',
    path: ['createdFrom'],
  });

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const slaComplianceResponseSchema = z.object({
  closedOnTime: z.number(),
  closedLate: z.number(),
  openOnTrack: z.number(),
  openAtRisk: z.number(),
  openBreached: z.number(),
  compliancePercent: z.number().nullable(),
});

export const ageingResponseSchema = z.array(z.object({ bucket: z.enum(['0-7', '8-30', '31-90', '91+']), count: z.number() }));
```

```typescript
// src/modules/dashboards-reports/reports.service.ts
import type { DataSource, SelectQueryBuilder } from 'typeorm';
import { Case } from '../cases/entities/case.entity';
import { applyCaseFilters, SLA_STATE_CONDITIONS, type Actor } from '../cases/cases.service';
import type { ReportQuery } from './reports.schemas';

export type SlaComplianceRow = {
  closedOnTime: number;
  closedLate: number;
  openOnTrack: number;
  openAtRisk: number;
  openBreached: number;
  compliancePercent: number | null;
};

export type AgeingBucket = '0-7' | '8-30' | '31-90' | '91+';

// Reports are role-gated to admin / legal manager / viewer, so the actor never
// triggers the requester scope; it is passed through so the one shared filter
// function stays the only place scope is decided.
export function reportBaseQuery(dataSource: DataSource, actor: Actor, filters: ReportQuery): SelectQueryBuilder<Case> {
  const { createdFrom, createdTo, ...caseFilters } = filters;
  const qb = dataSource.getRepository(Case).createQueryBuilder('c');
  applyCaseFilters(qb, actor, caseFilters);
  if (createdFrom) {
    qb.andWhere('c."createdAt" >= :createdFrom', { createdFrom });
  }
  if (createdTo) {
    qb.andWhere('c."createdAt" <= :createdTo', { createdTo });
  }
  return qb;
}

export async function slaComplianceReport(dataSource: DataSource, actor: Actor, filters: ReportQuery): Promise<SlaComplianceRow> {
  const row = await reportBaseQuery(dataSource, actor, filters)
    .select(`COUNT(*) FILTER (WHERE ${SLA_STATE_CONDITIONS.met})`, 'closedOnTime')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Closed' AND c."closedAt" > c."resolutionDueAt")`, 'closedLate')
    .addSelect(`COUNT(*) FILTER (WHERE ${SLA_STATE_CONDITIONS.on_track})`, 'openOnTrack')
    .addSelect(`COUNT(*) FILTER (WHERE ${SLA_STATE_CONDITIONS.at_risk})`, 'openAtRisk')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."resolutionDueAt" < now())`, 'openBreached')
    .getRawOne<Record<string, string>>();
  const closedOnTime = Number(row?.closedOnTime ?? 0);
  const closedLate = Number(row?.closedLate ?? 0);
  const closed = closedOnTime + closedLate;
  return {
    closedOnTime,
    closedLate,
    openOnTrack: Number(row?.openOnTrack ?? 0),
    openAtRisk: Number(row?.openAtRisk ?? 0),
    openBreached: Number(row?.openBreached ?? 0),
    compliancePercent: closed === 0 ? null : Math.round((closedOnTime / closed) * 1000) / 10,
  };
}

export async function ageingReport(
  dataSource: DataSource,
  actor: Actor,
  filters: ReportQuery,
): Promise<{ bucket: AgeingBucket; count: number }[]> {
  const row = await reportBaseQuery(dataSource, actor, filters)
    .select(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" > now() - interval '8 days')`, 'b0')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" <= now() - interval '8 days' AND c."createdAt" > now() - interval '31 days')`, 'b1')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" <= now() - interval '31 days' AND c."createdAt" > now() - interval '91 days')`, 'b2')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" != 'Closed' AND c."createdAt" <= now() - interval '91 days')`, 'b3')
    .getRawOne<Record<string, string>>();
  return [
    { bucket: '0-7', count: Number(row?.b0 ?? 0) },
    { bucket: '8-30', count: Number(row?.b1 ?? 0) },
    { bucket: '31-90', count: Number(row?.b2 ?? 0) },
    { bucket: '91+', count: Number(row?.b3 ?? 0) },
  ];
}
```

```typescript
// src/modules/dashboards-reports/reports.routes.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../shared/rbac';
import type { Actor } from '../cases/cases.service';
import { DEFAULT_EXPORT_ROW_CAP, sendCsvRows, type CsvColumn } from './csv';
import { ageingReport, slaComplianceReport, type SlaComplianceRow } from './reports.service';
import { ageingResponseSchema, reportQuerySchema, slaComplianceResponseSchema } from './reports.schemas';

export const REPORT_ROLES = ['admin', 'legal_manager', 'viewer'];

const SLA_COLUMNS: CsvColumn<SlaComplianceRow>[] = [
  { header: 'closedOnTime', value: (row) => row.closedOnTime },
  { header: 'closedLate', value: (row) => row.closedLate },
  { header: 'openOnTrack', value: (row) => row.openOnTrack },
  { header: 'openAtRisk', value: (row) => row.openAtRisk },
  { header: 'openBreached', value: (row) => row.openBreached },
  { header: 'compliancePercent', value: (row) => row.compliancePercent },
];

const AGEING_COLUMNS: CsvColumn<{ bucket: string; count: number }>[] = [
  { header: 'bucket', value: (row) => row.bucket },
  { header: 'count', value: (row) => row.count },
];

export default async function reportsRoutes(app: FastifyInstance, opts: { exportRowCap?: number } = {}): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const cap = opts.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP;
  const guard = [app.authenticate, requireRole(REPORT_ROLES)];
  const meta = { tags: ['Reports'], security: [{ bearerAuth: [] }] };
  const actorOf = (user: { id: string; role: string; departmentId: string | null; entityId: string | null; businessUnitId: string | null }): Actor => ({
    id: user.id,
    role: user.role,
    departmentId: user.departmentId,
    entityId: user.entityId,
    businessUnitId: user.businessUnitId,
  });

  typedApp.get('/reports/sla-compliance', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema, response: { 200: slaComplianceResponseSchema } },
  }, async (request) => slaComplianceReport(app.dataSource, actorOf(request.user), request.query));

  typedApp.get('/reports/sla-compliance/export', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema },
  }, async (request, reply) => {
    const row = await slaComplianceReport(app.dataSource, actorOf(request.user), request.query);
    return sendCsvRows(reply, 'sla-compliance', [row], SLA_COLUMNS, cap);
  });

  typedApp.get('/reports/ageing', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema, response: { 200: ageingResponseSchema } },
  }, async (request) => ageingReport(app.dataSource, actorOf(request.user), request.query));

  typedApp.get('/reports/ageing/export', {
    preHandler: guard,
    schema: { ...meta, querystring: reportQuerySchema },
  }, async (request, reply) => {
    const rows = await ageingReport(app.dataSource, actorOf(request.user), request.query);
    return sendCsvRows(reply, 'ageing', rows, AGEING_COLUMNS, cap);
  });
}
```

`src/app.ts`: import `reportsRoutes` and register `app.register(reportsRoutes, { exportRowCap: options.exportRowCap });` after `dashboardRoutes`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/dashboards-reports && npx tsc --noEmit`
Expected: PASS (dashboard file plus 8 new tests), `tsc` clean. Run the new file twice (the boundary tests rely on `now()` vs a one-hour margin, so they must be stable).

- [ ] **Step 5: Commit**

Create `decisions/dashboards-reports/task-05-reports-sla-ageing.md` and add one bullet to the top of the `## dashboards-reports` section in `decisions.md`.

```bash
git add src/modules/dashboards-reports/reports.schemas.ts src/modules/dashboards-reports/reports.service.ts src/modules/dashboards-reports/reports.routes.ts src/app.ts test/integration/modules/dashboards-reports/reports-sla-ageing.test.ts decisions.md decisions/dashboards-reports/task-05-reports-sla-ageing.md
git commit -m "feat: SLA compliance and ageing reports with CSV export"
```

---

### Task 6: Volume and workload reports

**Files:**
- Modify: `src/modules/dashboards-reports/reports.schemas.ts`
- Modify: `src/modules/dashboards-reports/reports.service.ts`
- Modify: `src/modules/dashboards-reports/reports.routes.ts`
- Test: `test/integration/modules/dashboards-reports/reports-volume-workload.test.ts`

**Interfaces:**
- Consumes: `reportBaseQuery`, `reportQuerySchema`, `REPORT_ROLES`, `sendCsvRows`, `CsvColumn` (Task 5); master-data entities `CaseCategory` (`case_categories`), `CaseType` (`case_types`), `OrgEntity` (`entities`), `BusinessUnit` (`business_units`), `Department` (`departments`), and `User`.
- Produces:
  - `volumeByCategoryReport(ds, actor, filters): Promise<{ categoryId; categoryName; caseTypeId; caseTypeName; count }[]>`
  - `volumeByOrganisationReport(ds, actor, filters): Promise<{ entityId; entityName; businessUnitId: string | null; businessUnitName: string | null; departmentId; departmentName; count }[]>`
  - `repWorkloadReport(ds, actor, filters): Promise<{ legalRepId; fullName; openCount; awaitingAcceptanceCount; overdueCount }[]>`
  - Routes `GET /reports/volume-by-category`, `GET /reports/volume-by-organisation`, `GET /reports/rep-workload`, each with an `/export` sibling.
  - Ordering (all three): `count` (or `openCount`) descending, then the name column ascending, then the id ascending — deterministic.
  - Volume reports count **all** cases (every status) matching the filters; rep workload counts **open** cases only that have an assigned rep (unassigned cases are not a row), `awaitingAcceptanceCount` = status Assigned, `overdueCount` = open and `resolutionDueAt < now()`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/dashboards-reports/reports-volume-workload.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithTimes } from '../../helpers/seed-case-times';
import { authHeader } from '../../helpers/auth-header';

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

describe('volume and workload reports', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const nameOf = async (table: string, id: string) => (await ds.query(`SELECT name FROM ${table} WHERE id = $1`, [id]))[0].name as string;

  async function twoMasters() {
    const first = await seedCaseMasterData(ds);
    const second = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: first.departmentId, entityId: first.entityId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    return { first, second, requesterId, managerId };
  }

  describe('GET /reports/volume-by-category', () => {
    it('counts every case per category and type with names, largest first', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, second, requesterId, managerId } = await twoMasters();
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'Submitted' });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'Closed' });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress' });
      await seedCaseWithTimes(ds, { ...second, requesterId, status: 'Submitted' });

      const res = await app.inject({ method: 'GET', url: '/reports/volume-by-category', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { categoryId: first.categoryId, categoryName: await nameOf('case_categories', first.categoryId), caseTypeId: first.caseTypeId, caseTypeName: await nameOf('case_types', first.caseTypeId), count: 3 },
        { categoryId: second.categoryId, categoryName: await nameOf('case_categories', second.categoryId), caseTypeId: second.caseTypeId, caseTypeName: await nameOf('case_types', second.caseTypeId), count: 1 },
      ]);
      await app.close();
    });

    it('returns an empty list when nothing matches and honours filters', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, second, requesterId, managerId } = await twoMasters();
      await seedCaseWithTimes(ds, { ...first, requesterId });
      await seedCaseWithTimes(ds, { ...second, requesterId });
      const headers = authHeader(app, managerId, 'legal_manager');

      const filtered = await app.inject({ method: 'GET', url: `/reports/volume-by-category?categoryId=${second.categoryId}`, headers });
      const none = await app.inject({ method: 'GET', url: '/reports/volume-by-category?status=Closed', headers });

      expect(filtered.json()).toHaveLength(1);
      expect(filtered.json()[0].categoryId).toBe(second.categoryId);
      expect(none.json()).toEqual([]);
      await app.close();
    });
  });

  describe('GET /reports/volume-by-organisation', () => {
    it('counts per entity, business unit and department, allowing a missing business unit', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, second, requesterId, managerId } = await twoMasters();
      await seedCaseWithTimes(ds, { ...first, requesterId });
      await seedCaseWithTimes(ds, { ...first, requesterId });
      await seedCaseWithTimes(ds, { ...second, requesterId, businessUnitId: null });

      const res = await app.inject({ method: 'GET', url: '/reports/volume-by-organisation', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          entityId: first.entityId,
          entityName: await nameOf('entities', first.entityId),
          businessUnitId: first.businessUnitId,
          businessUnitName: await nameOf('business_units', first.businessUnitId),
          departmentId: first.departmentId,
          departmentName: await nameOf('departments', first.departmentId),
          count: 2,
        },
        {
          entityId: second.entityId,
          entityName: await nameOf('entities', second.entityId),
          businessUnitId: null,
          businessUnitName: null,
          departmentId: second.departmentId,
          departmentName: await nameOf('departments', second.departmentId),
          count: 1,
        },
      ]);
      await app.close();
    });
  });

  describe('GET /reports/rep-workload', () => {
    it('counts open, awaiting-acceptance and overdue cases per rep and skips closed and unassigned cases', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, requesterId, managerId } = await twoMasters();
      const busyRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Busy Rep' });
      const quietRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Quiet Rep' });
      const idleRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Idle Rep' });
      const base = { ...first, requesterId };
      await seedCaseWithTimes(ds, { ...base, status: 'Assigned', assignedLegalRepId: busyRepId, resolutionDueAt: inHours(48) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: busyRepId, resolutionDueAt: inHours(-2) });
      await seedCaseWithTimes(ds, { ...base, status: 'Waiting on Input', assignedLegalRepId: busyRepId, resolutionDueAt: inHours(48) });
      await seedCaseWithTimes(ds, { ...base, status: 'In Progress', assignedLegalRepId: quietRepId, resolutionDueAt: inHours(48) });
      await seedCaseWithTimes(ds, { ...base, status: 'Closed', assignedLegalRepId: idleRepId, resolutionDueAt: inHours(-48), closedAt: inHours(-1) });
      await seedCaseWithTimes(ds, { ...base, status: 'Submitted', assignedLegalRepId: null, resolutionDueAt: inHours(-5) });

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { legalRepId: busyRepId, fullName: 'Busy Rep', openCount: 3, awaitingAcceptanceCount: 1, overdueCount: 1 },
        { legalRepId: quietRepId, fullName: 'Quiet Rep', openCount: 1, awaitingAcceptanceCount: 0, overdueCount: 0 },
      ]);
      await app.close();
    });

    it('returns an empty list when no rep has open work', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { managerId } = await twoMasters();

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.json()).toEqual([]);
      await app.close();
    });
  });

  describe('access and export', () => {
    it('forbids legal rep and requester and allows viewer on every route and export', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      for (const base of ['/reports/volume-by-category', '/reports/volume-by-organisation', '/reports/rep-workload']) {
        for (const url of [base, `${base}/export`]) {
          const viewerId = await seedUserWithRole(ds, 'viewer');
          const repId = await seedUserWithRole(ds, 'legal_rep');
          const requesterId = await seedUserWithRole(ds, 'requester');
          expect((await app.inject({ method: 'GET', url, headers: authHeader(app, viewerId, 'viewer') })).statusCode, url).toBe(200);
          expect((await app.inject({ method: 'GET', url, headers: authHeader(app, repId, 'legal_rep') })).statusCode, url).toBe(403);
          expect((await app.inject({ method: 'GET', url, headers: authHeader(app, requesterId, 'requester') })).statusCode, url).toBe(403);
          expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
        }
      }
      await app.close();
    });

    it('exports the same rows as the JSON route, with a header, quoting names with commas and neutralising formulas', async () => {
      const app = buildTestApp(ds);
      await app.ready();
      const { first, requesterId, managerId } = await twoMasters();
      const repId = await seedUserWithRole(ds, 'legal_rep', { fullName: '=HYPERLINK("http://evil")' });
      const otherRepId = await seedUserWithRole(ds, 'legal_rep', { fullName: 'Smith, Jane' });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: repId });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: otherRepId });
      const headers = authHeader(app, managerId, 'legal_manager');

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload/export', headers });

      const lines = res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(lines[0]).toBe('legalRepId,fullName,openCount,awaitingAcceptanceCount,overdueCount');
      expect(lines).toHaveLength(3);
      expect(res.body).toContain('"Smith, Jane"');
      expect(res.body).toContain(`'=HYPERLINK`);
      expect(res.body).not.toMatch(/,=HYPERLINK/);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="rep-workload-\d{8}\.csv"$/);
      await app.close();
    });

    it('truncates an export beyond the cap and says so', async () => {
      const app = buildTestApp(ds, { exportRowCap: 1 });
      await app.ready();
      const { first, requesterId, managerId } = await twoMasters();
      const repA = await seedUserWithRole(ds, 'legal_rep');
      const repB = await seedUserWithRole(ds, 'legal_rep');
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: repA });
      await seedCaseWithTimes(ds, { ...first, requesterId, status: 'In Progress', assignedLegalRepId: repB });

      const res = await app.inject({ method: 'GET', url: '/reports/rep-workload/export', headers: authHeader(app, managerId, 'legal_manager') });

      expect(res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean)).toHaveLength(2);
      expect(res.headers['x-export-total']).toBe('2');
      expect(res.headers['x-export-truncated']).toBe('true');
      await app.close();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/dashboards-reports/reports-volume-workload.test.ts`
Expected: FAIL — the three new routes return 404.

- [ ] **Step 3: Implement**

Add to `reports.schemas.ts`:

```typescript
export const volumeByCategoryResponseSchema = z.array(
  z.object({ categoryId: z.string(), categoryName: z.string(), caseTypeId: z.string(), caseTypeName: z.string(), count: z.number() }),
);

export const volumeByOrganisationResponseSchema = z.array(
  z.object({
    entityId: z.string(),
    entityName: z.string(),
    businessUnitId: z.string().nullable(),
    businessUnitName: z.string().nullable(),
    departmentId: z.string(),
    departmentName: z.string(),
    count: z.number(),
  }),
);

export const repWorkloadResponseSchema = z.array(
  z.object({
    legalRepId: z.string(),
    fullName: z.string(),
    openCount: z.number(),
    awaitingAcceptanceCount: z.number(),
    overdueCount: z.number(),
  }),
);
```

Add to `reports.service.ts` (import `CaseCategory`, `CaseType`, `OrgEntity`, `BusinessUnit`, `Department` from `../master-data/entities/*.entity` and `User` from `../users/entities/user.entity`):

```typescript
export async function volumeByCategoryReport(dataSource: DataSource, actor: Actor, filters: ReportQuery) {
  const rows = await reportBaseQuery(dataSource, actor, filters)
    .innerJoin(CaseCategory, 'cat', 'cat.id = c."categoryId"')
    .innerJoin(CaseType, 'ct', 'ct.id = c."caseTypeId"')
    .select('c."categoryId"', 'categoryId')
    .addSelect('cat.name', 'categoryName')
    .addSelect('c."caseTypeId"', 'caseTypeId')
    .addSelect('ct.name', 'caseTypeName')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c."categoryId"')
    .addGroupBy('cat.name')
    .addGroupBy('c."caseTypeId"')
    .addGroupBy('ct.name')
    .orderBy('COUNT(*)', 'DESC')
    .addOrderBy('cat.name', 'ASC')
    .addOrderBy('ct.name', 'ASC')
    .addOrderBy('c."caseTypeId"', 'ASC')
    .getRawMany<{ categoryId: string; categoryName: string; caseTypeId: string; caseTypeName: string; count: string }>();
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}

export async function volumeByOrganisationReport(dataSource: DataSource, actor: Actor, filters: ReportQuery) {
  const rows = await reportBaseQuery(dataSource, actor, filters)
    .innerJoin(OrgEntity, 'en', 'en.id = c."entityId"')
    .leftJoin(BusinessUnit, 'bu', 'bu.id = c."businessUnitId"')
    .innerJoin(Department, 'dep', 'dep.id = c."departmentId"')
    .select('c."entityId"', 'entityId')
    .addSelect('en.name', 'entityName')
    .addSelect('c."businessUnitId"', 'businessUnitId')
    .addSelect('bu.name', 'businessUnitName')
    .addSelect('c."departmentId"', 'departmentId')
    .addSelect('dep.name', 'departmentName')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c."entityId"')
    .addGroupBy('en.name')
    .addGroupBy('c."businessUnitId"')
    .addGroupBy('bu.name')
    .addGroupBy('c."departmentId"')
    .addGroupBy('dep.name')
    .orderBy('COUNT(*)', 'DESC')
    .addOrderBy('en.name', 'ASC')
    .addOrderBy('dep.name', 'ASC')
    .addOrderBy('c."businessUnitId"', 'ASC')
    .getRawMany<{
      entityId: string; entityName: string; businessUnitId: string | null; businessUnitName: string | null;
      departmentId: string; departmentName: string; count: string;
    }>();
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}

export async function repWorkloadReport(dataSource: DataSource, actor: Actor, filters: ReportQuery) {
  const rows = await reportBaseQuery(dataSource, actor, filters)
    .innerJoin(User, 'u', 'u.id = c."assignedLegalRepId"')
    .andWhere(`c."status" != 'Closed'`)
    .select('c."assignedLegalRepId"', 'legalRepId')
    .addSelect('u."fullName"', 'fullName')
    .addSelect('COUNT(*)', 'openCount')
    .addSelect(`COUNT(*) FILTER (WHERE c."status" = 'Assigned')`, 'awaitingAcceptanceCount')
    .addSelect('COUNT(*) FILTER (WHERE c."resolutionDueAt" < now())', 'overdueCount')
    .groupBy('c."assignedLegalRepId"')
    .addGroupBy('u."fullName"')
    .orderBy('COUNT(*)', 'DESC')
    .addOrderBy('u."fullName"', 'ASC')
    .addOrderBy('c."assignedLegalRepId"', 'ASC')
    .getRawMany<{ legalRepId: string; fullName: string; openCount: string; awaitingAcceptanceCount: string; overdueCount: string }>();
  return rows.map((row) => ({
    legalRepId: row.legalRepId,
    fullName: row.fullName,
    openCount: Number(row.openCount),
    awaitingAcceptanceCount: Number(row.awaitingAcceptanceCount),
    overdueCount: Number(row.overdueCount),
  }));
}
```

Add to `reports.routes.ts` six routes in the same style as Task 5 (three JSON routes with `response: { 200: <schema> }`, three `/export` routes returning `sendCsvRows(reply, '<name>', rows, COLUMNS, cap)`), with these column lists (header = property name, in this order):

- `volume-by-category`: `categoryId, categoryName, caseTypeId, caseTypeName, count`
- `volume-by-organisation`: `entityId, entityName, businessUnitId, businessUnitName, departmentId, departmentName, count`
- `rep-workload`: `legalRepId, fullName, openCount, awaitingAcceptanceCount, overdueCount`

Report names for filenames: `volume-by-category`, `volume-by-organisation`, `rep-workload`. All six use the same `guard` (`REPORT_ROLES`) and `actorOf(request.user)`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/dashboards-reports && npx tsc --noEmit`
Expected: PASS (all dashboards-reports files), `tsc` clean. If `ORDER BY` on an aggregate or an unmapped alias is rejected by TypeORM, find the smallest working form and keep every ordering rule above identical; record the change in your report.

- [ ] **Step 5: Commit**

Create `decisions/dashboards-reports/task-06-volume-and-workload-reports.md` and add one bullet to the top of the `## dashboards-reports` section in `decisions.md`.

```bash
git add src/modules/dashboards-reports/reports.schemas.ts src/modules/dashboards-reports/reports.service.ts src/modules/dashboards-reports/reports.routes.ts test/integration/modules/dashboards-reports/reports-volume-workload.test.ts decisions.md decisions/dashboards-reports/task-06-volume-and-workload-reports.md
git commit -m "feat: volume and rep workload reports with CSV export"
```

---

## Final verification

After Task 6 run the whole backend suite on a genuinely fresh test container (the test Postgres uses `tmpfs`, so only a recreated container guarantees empty state) and the typecheck:

```bash
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up -d
sleep 6
npx vitest run > /tmp/full.txt 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/full.txt
npx tsc --noEmit
```

Expected: all test files pass (previously 407 passed / 2 skipped; this plan adds roughly 80 more tests), `tsc` clean.
