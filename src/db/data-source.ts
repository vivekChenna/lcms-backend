import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadEnv } from '../config/env';

const env = loadEnv();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  synchronize: false,
  logging: env.NODE_ENV === 'development',
  entities: ['src/modules/**/entities/*.entity.ts', 'dist/modules/**/entities/*.entity.js'],
  migrations: ['src/db/migrations/*.ts', 'dist/db/migrations/*.js'],
});
