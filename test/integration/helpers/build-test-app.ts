import type { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { buildApp } from '../../../src/app';
import type { ObjectStorage } from '../../../src/shared/storage/object-storage';
import { DEFAULT_UPLOAD_CONFIG, type UploadConfig } from '../../../src/modules/documents/upload-config';
import type { SecurityConfig } from '../../../src/config/security';
import { InMemoryObjectStorage } from './in-memory-storage';

const TEST_SECURITY: SecurityConfig = {
  corsOrigins: ['http://localhost:5173'],
  cookie: { secure: false, sameSite: 'lax', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2_592_000 },
};

export function buildTestApp(
  dataSource: DataSource,
  options: { storage?: ObjectStorage; uploadConfig?: Partial<UploadConfig>; exportRowCap?: number; security?: Partial<SecurityConfig> } = {},
): FastifyInstance {
  return buildApp(dataSource, {
    storage: options.storage ?? new InMemoryObjectStorage(),
    uploadConfig: { ...DEFAULT_UPLOAD_CONFIG, ...options.uploadConfig },
    exportRowCap: options.exportRowCap,
    security: { ...TEST_SECURITY, ...options.security, cookie: { ...TEST_SECURITY.cookie, ...options.security?.cookie } },
  });
}
