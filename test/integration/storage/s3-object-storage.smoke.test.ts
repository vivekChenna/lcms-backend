import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { S3ObjectStorage } from '../../../src/shared/storage/s3-object-storage';

// Opt-in: runs only against a real S3-compatible endpoint (e.g. the dev MinIO).
//   S3_SMOKE_TEST=1 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY_ID=lcms \
//   S3_SECRET_ACCESS_KEY=lcms12345 npx vitest run test/integration/storage
const enabled = process.env.S3_SMOKE_TEST === '1';

describe.skipIf(!enabled)('S3ObjectStorage against a real S3-compatible endpoint', () => {
  it('round-trips and deletes an object', async () => {
    const storage = new S3ObjectStorage({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET ?? 'lcms-documents-smoke',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    });
    await storage.ensureBucket();
    const key = `smoke/${Date.now()}`;
    await storage.put(key, Readable.from([Buffer.from('hello')]), 'text/plain');
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await storage.delete(key);
  });
});
