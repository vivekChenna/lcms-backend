import { describe, it, expect } from 'vitest';
import {
  DEFAULT_UPLOAD_CONFIG,
  DOCUMENT_CATEGORIES,
  normalizeMimeType,
  parseUploadConfig,
  sanitizeFilename,
  validateUploadFile,
} from '../../../../src/modules/documents/upload-config';
import { ValidationError } from '../../../../src/shared/errors';

describe('upload config', () => {
  it('has the fixed category list and the default limits', () => {
    expect(DOCUMENT_CATEGORIES).toEqual(['Evidence', 'Correspondence', 'Legal Opinion', 'Contract', 'Closure Document', 'Other']);
    expect(DEFAULT_UPLOAD_CONFIG.maxBytes).toBe(26214400);
    expect(DEFAULT_UPLOAD_CONFIG.allowedExtensions).toEqual(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'txt']);
  });

  it('parses a csv allowlist, lowercasing and trimming', () => {
    expect(parseUploadConfig(100, ' PDF , png ')).toEqual({ maxBytes: 100, allowedExtensions: ['pdf', 'png'] });
  });

  it('refuses an unsupported extension in the allowlist at boot', () => {
    expect(() => parseUploadConfig(100, 'pdf,exe')).toThrow(/unsupported extension.*exe/);
  });

  it('refuses an inherited object key such as constructor as an extension', () => {
    expect(() => parseUploadConfig(100, 'constructor')).toThrow(/unsupported extension.*constructor/);
  });

  it('refuses an empty allowlist', () => {
    expect(() => parseUploadConfig(100, ' , ')).toThrow(/at least one extension/);
  });
});

describe('normalizeMimeType', () => {
  it('drops parameters and lowercases', () => {
    expect(normalizeMimeType('Text/Plain; charset=utf-8')).toBe('text/plain');
  });
});

describe('sanitizeFilename', () => {
  it('strips directory components, both separators', () => {
    expect(sanitizeFilename('../../etc/evil.pdf')).toBe('evil.pdf');
    expect(sanitizeFilename('..\\..\\windows\\evil.pdf')).toBe('evil.pdf');
  });

  it('strips control characters and trims', () => {
    expect(sanitizeFilename('  a\u0000b\u001f.pdf ')).toBe('ab.pdf');
  });

  it('keeps non-ASCII names intact', () => {
    expect(sanitizeFilename('عقد-2026.pdf')).toBe('عقد-2026.pdf');
  });

  it('truncates an over-long name to 255 characters while keeping the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(400)}.pdf`);
    expect(out.length).toBe(255);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});

describe('validateUploadFile', () => {
  it('accepts an allowed extension with a matching mime type', () => {
    expect(validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'Contract.PDF', 'application/pdf')).toEqual({ filename: 'Contract.PDF', extension: 'pdf' });
  });

  it('accepts docx and xlsx with their official mime types', () => {
    expect(validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').extension).toBe('docx');
    expect(validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').extension).toBe('xlsx');
  });

  it('rejects an extension that is not on the allowlist', () => {
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'virus.exe', 'application/octet-stream')).toThrow(ValidationError);
  });

  it('rejects a mime type that does not match the extension', () => {
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'a.pdf', 'image/png')).toThrow(/does not match/);
  });

  it('rejects a name with no extension and a name that sanitizes to empty', () => {
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, 'README', 'text/plain')).toThrow(ValidationError);
    expect(() => validateUploadFile(DEFAULT_UPLOAD_CONFIG, '../', 'text/plain')).toThrow(/filename is required/);
  });

  it('honours a narrowed allowlist', () => {
    const config = parseUploadConfig(100, 'pdf');
    expect(() => validateUploadFile(config, 'a.png', 'image/png')).toThrow(ValidationError);
  });
});
