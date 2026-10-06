import type { FastifyInstance } from 'fastify';
import type { DataSource } from 'typeorm';
import { buildApp } from '../../../src/app';
import type { ObjectStorage } from '../../../src/shared/storage/object-storage';
import { DEFAULT_UPLOAD_CONFIG, type UploadConfig } from '../../../src/modules/documents/upload-config';
import { InMemoryObjectStorage } from './in-memory-storage';

export function buildTestApp(
  dataSource: DataSource,
  options: { storage?: ObjectStorage; uploadConfig?: Partial<UploadConfig>; exportRowCap?: number } = {},
): FastifyInstance {
  return buildApp(dataSource, {
    storage: options.storage ?? new InMemoryObjectStorage(),
    uploadConfig: { ...DEFAULT_UPLOAD_CONFIG, ...options.uploadConfig },
    exportRowCap: options.exportRowCap,
  });
}
