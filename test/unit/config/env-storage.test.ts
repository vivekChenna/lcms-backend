import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('storage and upload env settings', () => {
  it('defaults the upload settings and leaves S3 settings optional', () => {
    const env = loadEnv({ ...base });
    expect(env.UPLOAD_MAX_BYTES).toBe(26214400);
    expect(env.UPLOAD_ALLOWED_EXTENSIONS).toBe('pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it('parses explicit S3 and upload settings', () => {
    const env = loadEnv({
      ...base,
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'me-south-1',
      S3_BUCKET: 'lcms-documents',
      S3_ACCESS_KEY_ID: 'lcms',
      S3_SECRET_ACCESS_KEY: 'lcms12345',
      S3_FORCE_PATH_STYLE: 'false',
      UPLOAD_MAX_BYTES: '1048576',
      UPLOAD_ALLOWED_EXTENSIONS: 'pdf,png',
    });
    expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
    expect(env.S3_BUCKET).toBe('lcms-documents');
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.UPLOAD_MAX_BYTES).toBe(1048576);
    expect(env.UPLOAD_ALLOWED_EXTENSIONS).toBe('pdf,png');
  });
});
