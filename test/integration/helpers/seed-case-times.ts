import type { DataSource } from 'typeorm';
import { Case } from '../../../src/modules/cases/entities/case.entity';
import { seedCase } from './seed-case';

// seedCase cannot set createdAt / resolutionDueAt / closedAt directly; reports and
// the dashboard need cases at precise ages and due times.
export async function seedCaseWithTimes(
  ds: DataSource,
  overrides: Parameters<typeof seedCase>[1] & { createdAt?: Date; resolutionDueAt?: Date; closedAt?: Date | null },
): Promise<Case> {
  const { createdAt, resolutionDueAt, closedAt, ...rest } = overrides;
  const row = await seedCase(ds, rest);
  if (createdAt) {
    await ds.query(`UPDATE cases SET "createdAt" = $1 WHERE id = $2`, [createdAt, row.id]);
  }
  if (resolutionDueAt) {
    await ds.query(`UPDATE cases SET "resolutionDueAt" = $1 WHERE id = $2`, [resolutionDueAt, row.id]);
  }
  if (closedAt !== undefined) {
    await ds.query(`UPDATE cases SET "closedAt" = $1 WHERE id = $2`, [closedAt, row.id]);
  }
  return ds.getRepository(Case).findOneByOrFail({ id: row.id });
}
