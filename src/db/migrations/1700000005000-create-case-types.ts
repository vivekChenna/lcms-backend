import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateCaseTypes1700000005000 implements MigrationInterface {
  name = 'CreateCaseTypes1700000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'case_types',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'categoryId', type: 'uuid' },
          { name: 'name', type: 'varchar' },
          { name: 'description', type: 'varchar', isNullable: true },
          { name: 'slaAckHours', type: 'int' },
          { name: 'slaResolutionHours', type: 'int' },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'case_types',
      new TableForeignKey({ columnNames: ['categoryId'], referencedTableName: 'case_categories', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('case_types');
  }
}
