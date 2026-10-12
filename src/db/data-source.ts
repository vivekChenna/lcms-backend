import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadEnv } from '../config/env';
import { entities } from './entities';
import { migrations } from './migrations';

const env = loadEnv();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  // every table and the migrations history live in this schema; search_path makes the raw SQL agree
  schema: env.DB_SCHEMA,
  extra: { options: `-c search_path=${env.DB_SCHEMA}` },
  synchronize: false,
  logging: env.NODE_ENV === 'development',
  entities,
  migrations,
});
