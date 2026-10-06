# Task 2 — CSV builder

**Date:** 2026-10-08

**What:** Created `src/modules/dashboards-reports/csv.ts` with a CSV builder that sanitizes cell values and generates RFC 4180 CSV with BOM and CRLF line endings. Exports `toCsvCell(value)` to render cells (strings, dates, numbers, objects, nulls), prefixing formula-like strings (`=`, `+`, `-`, `@`, tab, CR) with an apostrophe to prevent formula injection in Excel/Sheets, and quoting cells containing commas, quotes, or line breaks per RFC 4180. Exports `toCsv(rows, columns)` to build a complete CSV with UTF-8 BOM and `CsvColumn<T>` shape for declarative column mapping. Exports `sendCsv()` and `sendCsvRows()` helpers to attach Fastify response headers (`X-Export-Total`, `X-Export-Truncated`) and set the content type and filename. Exports `exportFilename(name)` to generate `<name>-YYYYMMDD.csv` using UTC date, and `DEFAULT_EXPORT_ROW_CAP = 10_000` as the cap for `sendCsvRows()`.

**Why:** Dashboards and reports must be exportable as CSV. The builder must prevent injection attacks in spreadsheets while honoring CSV and internationalization standards, so that a legal case list can be reliably audited in Excel without risk. Sharing one sanitization function ensures all exports use the same rules. The cap and truncation flag let the API signal when it has cut off results, and the headers make that metadata discoverable to clients.
