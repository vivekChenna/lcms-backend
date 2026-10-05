import 'reflect-metadata';
import { buildApp } from './app';
import { AppDataSource } from './db/data-source';
import { loadEnv } from './config/env';
import { createS3StorageFromEnv } from './shared/storage/s3-object-storage';
import { parseUploadConfig } from './modules/documents/upload-config';

async function main(): Promise<void> {
  const env = loadEnv();
  const storage = createS3StorageFromEnv(env);
  await storage.ensureBucket();
  const uploadConfig = parseUploadConfig(env.UPLOAD_MAX_BYTES, env.UPLOAD_ALLOWED_EXTENSIONS);
  await AppDataSource.initialize();
  const app = buildApp(AppDataSource, { storage, uploadConfig });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await AppDataSource.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
