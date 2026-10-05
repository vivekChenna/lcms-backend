// test/unit/modules/documents/content-disposition.test.ts
import { describe, it, expect } from 'vitest';
import { contentDispositionHeader } from '../../../../src/modules/documents/content-disposition';

describe('contentDispositionHeader', () => {
  it('builds an attachment header with an ASCII fallback and an RFC 5987 name', () => {
    expect(contentDispositionHeader('attachment', 'contract.pdf')).toBe(`attachment; filename="contract.pdf"; filename*=UTF-8''contract.pdf`);
  });

  it('supports inline preview', () => {
    expect(contentDispositionHeader('inline', 'a.png')).toMatch(/^inline; /);
  });

  it('encodes non-ASCII names and keeps a safe ASCII fallback', () => {
    const header = contentDispositionHeader('attachment', 'عقد.pdf');
    expect(header).toContain(`filename*=UTF-8''%D8%B9%D9%82%D8%AF.pdf`);
    expect(header).toContain('filename="___.pdf"');
  });

  it('neutralises quotes, backslashes and header-injection characters', () => {
    const header = contentDispositionHeader('attachment', 'a"b\\c\r\nX-Evil: 1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('filename="')[1].split('";')[0]).not.toMatch(/["\\]/);
  });
});
