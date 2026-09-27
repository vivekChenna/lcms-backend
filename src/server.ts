import 'reflect-metadata';
import { buildApp } from './app';
import { AppDataSource } from './db/data-source';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  await AppDataSource.initialize();
  const app = buildApp(AppDataSource);

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
