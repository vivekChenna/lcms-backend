import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreateAuditLog1700000002000 implements MigrationInterface {
  name = 'CreateAuditLog1700000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'audit_log',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid', isNullable: true },
          { name: 'actorId', type: 'uuid' },
          { name: 'action', type: 'varchar' },
          { name: 'beforeValue', type: 'jsonb', isNullable: true },
          { name: 'afterValue', type: 'jsonb', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('audit_log');
  }
}
