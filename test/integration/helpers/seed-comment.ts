import type { DataSource } from 'typeorm';
import { CaseComment } from '../../../src/modules/comments/entities/case-comment.entity';

export async function seedComment(
  ds: DataSource,
  overrides: { caseId: string; authorId: string; body?: string; isInternal?: boolean; deletedAt?: Date | null },
): Promise<CaseComment> {
  const repo = ds.getRepository(CaseComment);
  return repo.save(
    repo.create({
      caseId: overrides.caseId,
      authorId: overrides.authorId,
      body: overrides.body ?? 'A comment',
      isInternal: overrides.isInternal ?? false,
      deletedAt: overrides.deletedAt ?? null,
    }),
  );
}
