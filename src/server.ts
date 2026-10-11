import 'reflect-metadata';
import { buildApp } from './app';
import { AppDataSource } from './db/data-source';
import { installRowLevelSecurity } from './db/row-level-security';
import { loadEnv } from './config/env';
import { createS3StorageFromEnv } from './shared/storage/s3-object-storage';
import { UnavailableObjectStorage } from './shared/storage/unavailable-object-storage';
import type { ObjectStorage } from './shared/storage/object-storage';
import { parseUploadConfig } from './modules/documents/upload-config';
import { createMailerFromEnv } from './modules/notifications/email/nodemailer-mailer';
import { startEmailWorker } from './modules/notifications/email/email-dispatcher';
import { startSlaBreachWorker } from './modules/sla/sla-breach-job';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const env = loadEnv();

  // Storage and email are optional at startup: when they are not configured (or
  // storage is unreachable) the app logs a warning and keeps running instead of
  // crashing. Document file operations then return 503 and queued emails wait.
  let storage: ObjectStorage;
  try {
    const s3 = createS3StorageFromEnv(env);
    await s3.ensureBucket();
    storage = s3;
  } catch (error) {
    console.warn(`WARNING: document storage is unavailable, file uploads and downloads will fail: ${describe(error)}`);
    storage = new UnavailableObjectStorage();
  }

  let mailer: ReturnType<typeof createMailerFromEnv> | null = null;
  try {
    mailer = createMailerFromEnv(env);
  } catch (error) {
    console.warn(`WARNING: email is disabled, notification emails will stay queued: ${describe(error)}`);
  }

  const uploadConfig = parseUploadConfig(env.UPLOAD_MAX_BYTES, env.UPLOAD_ALLOWED_EXTENSIONS);
  await AppDataSource.initialize();
  // BRD AC-03: the database enforces who may see which rows. Mandatory in production.
  await installRowLevelSecurity(AppDataSource, { required: env.NODE_ENV === 'production' });
  if (!env.FRONTEND_URL) {
    console.warn('WARNING: FRONTEND_URL is not set, so invitation and password-reset emails cannot be sent.');
  }
  const app = buildApp(AppDataSource, { storage, uploadConfig, mailer, frontendUrl: env.FRONTEND_URL });
  const emailWorker = mailer
    ? startEmailWorker({
        dataSource: AppDataSource,
        mailer,
        onError: (error) => app.log.error(error, 'email dispatch failed'),
      })
    : null;
  const slaBreachWorker = startSlaBreachWorker({
    dataSource: AppDataSource,
    onError: (error) => app.log.error(error, 'sla breach scan failed'),
  });

  const shutdown = async (): Promise<void> => {
    await emailWorker?.stop();
    await slaBreachWorker.stop();
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
