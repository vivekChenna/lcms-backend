import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateCases1700000010000 implements MigrationInterface {
  name = 'CreateCases1700000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE SEQUENCE case_reference_seq START 1');

    await queryRunner.createTable(
      new Table({
        name: 'cases',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'referenceNumber', type: 'varchar', isUnique: true },
          { name: 'title', type: 'varchar' },
          { name: 'description', type: 'varchar' },
          { name: 'declarationConfirmed', type: 'boolean' },
          { name: 'categoryId', type: 'uuid' },
          { name: 'caseTypeId', type: 'uuid' },
          { name: 'departmentId', type: 'uuid' },
          { name: 'entityId', type: 'uuid' },
          { name: 'businessUnitId', type: 'uuid', isNullable: true },
          { name: 'priority', type: 'varchar', default: `'P3'` },
          { name: 'status', type: 'varchar', default: `'Submitted'` },
          { name: 'isEscalated', type: 'boolean', default: false },
          { name: 'escalationReason', type: 'varchar', isNullable: true },
          { name: 'waitingOnReason', type: 'varchar', isNullable: true },
          { name: 'requesterId', type: 'uuid' },
          { name: 'assignedLegalRepId', type: 'uuid', isNullable: true },
          { name: 'assignmentAcceptedAt', type: 'timestamptz', isNullable: true },
          { name: 'ackDueAt', type: 'timestamptz' },
          { name: 'resolutionDueAt', type: 'timestamptz' },
          { name: 'slaBreachNotifiedAt', type: 'timestamptz', isNullable: true },
          { name: 'closureSummary', type: 'varchar', isNullable: true },
          { name: 'closureOutcomeId', type: 'uuid', isNullable: true },
          { name: 'closedById', type: 'uuid', isNullable: true },
          { name: 'closedAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['categoryId'], referencedTableName: 'case_categories', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['caseTypeId'], referencedTableName: 'case_types', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['departmentId'], referencedTableName: 'departments', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['entityId'], referencedTableName: 'entities', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['businessUnitId'], referencedTableName: 'business_units', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['requesterId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['assignedLegalRepId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['closureOutcomeId'], referencedTableName: 'closure_outcomes', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('cases', new TableForeignKey({ columnNames: ['closedById'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('cases');
    await queryRunner.query('DROP SEQUENCE case_reference_seq');
  }
}
