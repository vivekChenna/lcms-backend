import crypto from 'node:crypto';

export type MultipartPart = { name: string; filename: string; contentType: string; content: Buffer | string };

export function buildMultipartBody(parts: MultipartPart[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----lcmstest${crypto.randomUUID().replace(/-/g, '')}`;
  const buffers: Buffer[] = [];
  for (const part of parts) {
    buffers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
        'utf8',
      ),
      Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(buffers), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
