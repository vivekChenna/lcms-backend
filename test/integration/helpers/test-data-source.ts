import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { entities } from '../../../src/db/entities';
import { migrations } from '../../../src/db/migrations';

export function buildTestDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: 'postgres://lcms:lcms@localhost:5433/lcms_test',
    synchronize: false,
    logging: false,
    entities,
    migrations,
  });
}
