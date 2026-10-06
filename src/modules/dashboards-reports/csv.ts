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
