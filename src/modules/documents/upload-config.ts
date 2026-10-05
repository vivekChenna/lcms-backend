import path from 'node:path';
import { ValidationError } from '../../shared/errors';

export const DOCUMENT_CATEGORIES = [
  'Evidence',
  'Correspondence',
  'Legal Opinion',
  'Contract',
  'Closure Document',
  'Other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const EXTENSION_MIME_TYPES: Record<string, readonly string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  txt: ['text/plain'],
};

export type UploadConfig = { maxBytes: number; allowedExtensions: string[] };

export const DEFAULT_UPLOAD_CONFIG: UploadConfig = {
  maxBytes: 26_214_400,
  allowedExtensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'txt'],
};

export function parseUploadConfig(maxBytes: number, allowedCsv: string): UploadConfig {
  const allowedExtensions = allowedCsv
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowedExtensions.length === 0) {
    throw new Error('UPLOAD_ALLOWED_EXTENSIONS must list at least one extension');
  }
  const unknown = allowedExtensions.filter((extension) => !(extension in EXTENSION_MIME_TYPES));
  if (unknown.length > 0) {
    throw new Error(`UPLOAD_ALLOWED_EXTENSIONS contains unsupported extension(s): ${unknown.join(', ')}`);
  }
  return { maxBytes, allowedExtensions };
}

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length > 255) {
    const extension = path.extname(cleaned);
    cleaned = cleaned.slice(0, 255 - extension.length) + extension;
  }
  return cleaned;
}

export function validateUploadFile(
  config: UploadConfig,
  rawFilename: string,
  mimeType: string,
): { filename: string; extension: string } {
  const filename = sanitizeFilename(rawFilename);
  if (!filename) {
    throw new ValidationError('A filename is required');
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!extension || !config.allowedExtensions.includes(extension)) {
    throw new ValidationError(`File type '${extension ? `.${extension}` : 'without an extension'}' is not allowed`);
  }
  const expected = EXTENSION_MIME_TYPES[extension];
  if (!expected.includes(normalizeMimeType(mimeType))) {
    throw new ValidationError(`Declared type '${mimeType}' does not match '.${extension}'`);
  }
  return { filename, extension };
}
