import { describe, it, expect } from 'vitest';
import { buildMultipartBody } from '../../integration/helpers/multipart';

describe('buildMultipartBody', () => {
  it('builds a body whose boundary matches the content-type header', () => {
    const { payload, headers } = buildMultipartBody([
      { name: 'file', filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('PDFDATA') },
    ]);
    const boundary = /boundary=(.+)$/.exec(headers['content-type'])?.[1];
    expect(boundary).toBeTruthy();
    const text = payload.toString('utf8');
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="a.pdf"');
    expect(text).toContain('Content-Type: application/pdf');
    expect(text).toContain('PDFDATA');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});
