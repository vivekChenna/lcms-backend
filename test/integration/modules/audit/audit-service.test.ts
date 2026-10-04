import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { logAuditEvent } from '../../../../src/modules/audit/audit.service';
import { AuditLog } from '../../../../src/modules/audit/entities/audit-log.entity';

describe('logAuditEvent', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('writes an entry with before/after values', async () => {
    await logAuditEvent(ds, {
      actorId: '11111111-1111-1111-1111-111111111111',
      action: 'user.deactivated',
      beforeValue: { isActive: true },
      afterValue: { isActive: false },
    });

    const rows = await ds.getRepository(AuditLog).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.deactivated');
    expect(rows[0].beforeValue).toEqual({ isActive: true });
    expect(rows[0].afterValue).toEqual({ isActive: false });
    expect(rows[0].caseId).toBeNull();
  });

  it('defaults beforeValue/afterValue to null when omitted', async () => {
    await logAuditEvent(ds, { actorId: '11111111-1111-1111-1111-111111111111', action: 'user.created' });
    const [row] = await ds.getRepository(AuditLog).find();
    expect(row.beforeValue).toBeNull();
    expect(row.afterValue).toBeNull();
  });
});
