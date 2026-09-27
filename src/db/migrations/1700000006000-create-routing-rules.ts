import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateRoutingRules1700000006000 implements MigrationInterface {
  name = 'CreateRoutingRules1700000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'routing_rules',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'matchCriteria', type: 'jsonb' },
          { name: 'targetLegalRepId', type: 'uuid' },
          { name: 'priorityOrder', type: 'int', default: 0 },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'routing_rules',
      new TableForeignKey({ columnNames: ['targetLegalRepId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('routing_rules');
  }
}
