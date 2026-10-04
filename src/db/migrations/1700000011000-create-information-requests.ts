import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateInformationRequests1700000011000 implements MigrationInterface {
  name = 'CreateInformationRequests1700000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'information_requests',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid' },
          { name: 'subject', type: 'varchar' },
          { name: 'requirementDescription', type: 'varchar' },
          { name: 'raisedById', type: 'uuid' },
          { name: 'responderId', type: 'uuid' },
          { name: 'dueDate', type: 'timestamptz', isNullable: true },
          { name: 'status', type: 'varchar', default: `'open'` },
          { name: 'responseText', type: 'varchar', isNullable: true },
          { name: 'reopenedFromId', type: 'uuid', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['caseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['raisedById'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['responderId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('information_requests', new TableForeignKey({ columnNames: ['reopenedFromId'], referencedTableName: 'information_requests', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('information_requests');
  }
}
