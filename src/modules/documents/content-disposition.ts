// src/modules/documents/content-disposition.ts
export function contentDispositionHeader(disposition: 'attachment' | 'inline', filename: string): string {
  // ASCII fallback: printable ASCII only, no quotes/backslashes. Control and
  // non-ASCII characters (including CR/LF) become "_".
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 5987 percent-encoding, additionally escaping the characters
  // encodeURIComponent leaves alone but RFC 5987 does not allow.
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
