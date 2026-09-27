import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadEnv } from '../config/env';
import { entities } from './entities';
import { migrations } from './migrations';

const env = loadEnv();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  synchronize: false,
  logging: env.NODE_ENV === 'development',
  entities,
  migrations,
});
